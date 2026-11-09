"""Turns a look script into the assets of a live island.

The world the viewer sees is the Cycles frame itself: a plate, with a depth map under it so live objects pass in front
of and behind what it shows. Everything that moves is left out of the plate and exported as a live actor.

In a look script:

    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "shared"))
    import plate_tools as PT
    PT.setup(ARGS, globals())                  # reads --plate <assets dir>, does nothing without it

    with PT.actor("sails", pivot=hub_world):   # goes live: not in the plate, a node ACT_sails in actors.glb
        ...G.add calls...
    with PT.drop():                            # not in the plate, not exported: a live copy takes its place
        ...G.add calls...
    PT.spot("rack", world_pos, scale=s)        # a named place the island reads at run time, in world coordinates
    PT.path("leg0", [p0, p1, p2])              # a named polyline
    PT.bot("harvest", base_world, size, yaw)   # where a mascot stands
    PT.accents(harvest=["led_on_harvest"], press=[...], lead=[...])   # bot coloured lights, one group per station
    PT.masks(water=["water"], flow=["cloud"], pulse=["lamp"])         # regions of the plate that stay alive
    PT.flat("wood", (0.3, 0.2, 0.1), rough=0.6)                       # flat stand-in for a procedural actor material

    # in place of the final render call:
    if PT.ON:
        PT.finish(camera_object)

Run: tools/render.sh blender/<island>/island_look.py <any.png> 1920 64 --plate islands/<island>/assets [--passes plate,accent,aux,env,actors]

Passes: plate (the frame), accent (bot lights alone), aux (depth + masks), motion (wind, run and lift fields), env (pano for live reflections), actors (GLB + plate.json).
Width and samples come from the render.sh arguments.
"""
import json
import math
import os
import shutil
import subprocess
from contextlib import contextmanager

import bpy
import numpy as np
from mathutils import Matrix, Vector

ON = False
DIR = None
PASSES = ("plate", "accent", "aux", "motion", "env", "actors")
WIDTH = 1920
SAMPLES = 64
SCRATCH = None
_g = None
_geo_name = "G"
ACTORS = {}
DROPPED = []
SPOTS = {}
PATHS = {}
BOTS = {}
ACCENTS = {}
MASKS = {}
MOTION = {}
LIFT = []
LIFT_SKIP = []
FLATS = {}
NOTES = {}
AUX_HIDE = []
FACE_BUDGET = 120000


def to_three(p):
    return [float(p[0]), float(p[2]), float(-p[1])]


def setup(args, script_globals, geo_name="G"):
    global ON, DIR, PASSES, WIDTH, SAMPLES, SCRATCH, _g, _geo_name
    _g = script_globals
    _geo_name = geo_name
    if "--plate" not in args:
        return
    ON = True
    DIR = os.path.abspath(args[args.index("--plate") + 1])
    os.makedirs(DIR, exist_ok=True)
    SCRATCH = os.path.join(DIR, "..", "..", "..", ".work", "plates", os.path.basename(os.path.dirname(DIR)))
    SCRATCH = os.path.abspath(SCRATCH)
    os.makedirs(SCRATCH, exist_ok=True)
    if "--passes" in args:
        PASSES = tuple(args[args.index("--passes") + 1].split(","))
    WIDTH = int(args[1])
    SAMPLES = int(args[2])
    print("plate mode", DIR, PASSES, WIDTH, SAMPLES, flush=True)


@contextmanager
def _collect():
    geo = _g[_geo_name]
    tmp = type(geo)()
    before = set(bpy.data.objects)
    _g[_geo_name] = tmp
    try:
        yield
    finally:
        _g[_geo_name] = geo
        if tmp.d:
            tmp.build()
    return_new = [o for o in bpy.data.objects if o not in before]
    _collect.new = return_new


@contextmanager
def actor(name, pivot=None):
    """Geometry added to G inside this block goes live. In a plain look render it stays in the frame."""
    if not ON:
        yield
        return
    with _collect():
        yield
    entry = ACTORS.setdefault(name, dict(pivot=None, objs=[]))
    if pivot is not None:
        entry["pivot"] = tuple(float(v) for v in pivot)
    entry["objs"].extend(_collect.new)


@contextmanager
def drop():
    """Geometry added to G inside this block stays out of the plate, because a live copy takes its place."""
    if not ON:
        yield
        return
    with _collect():
        yield
    DROPPED.extend(_collect.new)


def spot(name, pos, scale=1.0, yaw=0.0, **extra):
    """A named place. yaw is radians around the up axis, same sign in Blender and three."""
    SPOTS.setdefault(name, []).append(dict(p=to_three(pos), s=float(scale), yaw=float(yaw), **extra))


def path(name, pts):
    PATHS[name] = [to_three(p) for p in pts]


def bot(key, base, size, yaw=0.0, shape=None, tool=None):
    BOTS[key] = dict(p=to_three(base), size=float(size), yaw=float(yaw), shape=shape, tool=tool)


def accents(**groups):
    ACCENTS.update(groups)


def masks(**groups):
    MASKS.update(groups)


def motion(**mats):
    """What moves in the wind or runs like water, per material. plate_motion.webp: R bend, G phase, B run.
    bend=1.0 is a flat amount. axis="object", h=1.6 grows from the object's origin to h in local height.
    axis="world", z0=0.0, h=1.0 grows with world height. phase="object" gives each object its own, else it varies across the world.
    run=1.0 streams like falling water."""
    MOTION.update(mats)


def lift(zones, skip=()):
    """Up to three bodies that rise and fall, as world spheres (x, y, z, r) in Blender coordinates. plate_lift.webp, one per channel.
    skip: materials never part of a body, like cloud and sky."""
    LIFT[:] = list(zones)[:3]
    LIFT_SKIP[:] = list(skip)


def flat(name, color, rough=0.5, metal=0.0, emis=None, emis_str=0.0, alpha=1.0):
    FLATS[name] = dict(color=color, rough=rough, metal=metal, emis=emis, emis_str=emis_str, alpha=alpha)


def note(**kw):
    NOTES.update(kw)


def aux_hide(*names):
    AUX_HIDE.extend(names)


# ---------- helpers ----------
def _principled(m):
    if not m or not m.use_nodes:
        return None
    for n in m.node_tree.nodes:
        if n.type == "BSDF_PRINCIPLED":
            return n
    return None


def _actor_objs():
    out = []
    for e in ACTORS.values():
        out.extend(e["objs"])
    return out


def _alive(objs):
    names = set(bpy.data.objects.keys())
    return [o for o in objs if o.name in names]


def _render_to(path_, fmt="PNG", depth="8", color="RGB"):
    sc = bpy.context.scene
    st = sc.render.image_settings
    st.file_format = fmt
    st.color_depth = depth
    st.color_mode = color
    if fmt == "OPEN_EXR":
        st.exr_codec = "ZIP"
    sc.render.filepath = path_
    sc.render.use_border = False
    bpy.ops.render.render(write_still=True)


def _webp(src, dst, q=90, lossless=False):
    cmd = ["/opt/homebrew/bin/cwebp", "-quiet"]
    cmd += ["-lossless"] if lossless else ["-q", str(q), "-m", "6", "-sharp_yuv"]
    subprocess.run(cmd + [src, "-o", dst], check=True)


def _load_pixels(path_):
    im = bpy.data.images.load(path_)
    w, h = im.size
    arr = np.empty(w * h * im.channels, dtype=np.float32)
    im.pixels.foreach_get(arr)
    arr = arr.reshape(h, w, im.channels)[::-1]      # top row first
    bpy.data.images.remove(im)
    return arr, w, h


def _res(width):
    sc = bpy.context.scene
    sc.render.resolution_x = width
    sc.render.resolution_y = round(width * 9 / 16)
    sc.render.resolution_percentage = 100


def _set_accent_strength(zero, saved=None):
    """Turns the accent emitters off for the plate. Returns what it changed so it can be restored."""
    saved = {} if saved is None else saved
    for names in ACCENTS.values():
        for name in names:
            m = bpy.data.materials.get(name)
            if not m or not m.use_nodes:
                continue
            for n in m.node_tree.nodes:
                sock = None
                if n.type == "BSDF_PRINCIPLED":
                    sock = n.inputs["Emission Strength"]
                elif n.type == "EMISSION":
                    sock = n.inputs["Strength"]
                if sock is not None and not sock.is_linked:
                    saved[(name, n.name)] = sock.default_value
                    sock.default_value = 0.0
    return saved


# ---------- passes ----------
def pass_plate():
    sc = bpy.context.scene
    _res(WIDTH)
    sc.cycles.samples = SAMPLES
    saved = _set_accent_strength(True)
    png = os.path.join(SCRATCH, "plate.png")
    _render_to(png)
    _webp(png, os.path.join(DIR, "plate.webp"), q=90)
    for (name, node), v in saved.items():
        m = bpy.data.materials[name]
        n = m.node_tree.nodes[node]
        n.inputs["Emission Strength" if n.type == "BSDF_PRINCIPLED" else "Strength"].default_value = v


def pass_accent():
    """Only the bot coloured lights, red, green and blue for stations one, two and three, so the page can recolour them."""
    if not ACCENTS:
        return
    sc = bpy.context.scene
    saved_world = sc.world
    sc.world = None
    hidden = []
    for o in bpy.data.objects:
        if o.type == "LIGHT" and not o.hide_render:
            o.hide_render = True
            hidden.append(o)
    accent_names = {n: i for i, names in enumerate(ACCENTS.values()) for n in names}
    saved = []
    cut = []
    for m in bpy.data.materials:
        if not m.use_nodes:
            continue
        idx = accent_names.get(m.name)
        for n in m.node_tree.nodes:
            if n.type == "BSDF_PRINCIPLED":
                col, st = n.inputs["Emission Color"], n.inputs["Emission Strength"]
            elif n.type == "EMISSION":
                col, st = n.inputs["Color"], n.inputs["Strength"]
            else:
                continue
            saved.append((col, tuple(col.default_value), st, st.default_value))
            if idx is None:
                # A strength driven by nodes (a fresnel edge, a falloff) has to be cut, or that emitter leaks into the accent.
                for link in list(st.links):
                    cut.append((m.node_tree, link.from_socket, st))
                    m.node_tree.links.remove(link)
                st.default_value = 0.0
            else:
                c = [0.0, 0.0, 0.0, 1.0]
                c[idx] = 1.0
                if not col.is_linked:
                    col.default_value = c
    view, look = sc.view_settings.view_transform, sc.view_settings.look
    sc.view_settings.view_transform = "Standard"
    sc.view_settings.look = "None"
    _res(min(WIDTH, 1920))
    sc.cycles.samples = max(32, SAMPLES // 3)
    png = os.path.join(SCRATCH, "accent.png")
    _render_to(png)
    _webp(png, os.path.join(DIR, "plate_accent.webp"), q=88)
    sc.view_settings.view_transform, sc.view_settings.look = view, look
    for col, cv, st, sv in saved:
        if not col.is_linked:
            col.default_value = cv
        if not st.is_linked:
            st.default_value = sv
    for tree, src, dst in cut:
        tree.links.new(src, dst)
    for o in hidden:
        o.hide_render = False
    sc.world = saved_world


def pass_env(center):
    """A sphere of what the live objects would reflect, from the middle of the line."""
    sc = bpy.context.scene
    cam_data = bpy.data.cameras.new("env_cam")
    cam_data.type = "PANO"
    try:
        cam_data.panorama_type = "EQUIRECTANGULAR"
    except AttributeError:
        cam_data.cycles.panorama_type = "EQUIRECTANGULAR"
    cam = bpy.data.objects.new("env_cam", cam_data)
    bpy.context.collection.objects.link(cam)
    cam.location = center
    cam.rotation_euler = (math.pi / 2, 0.0, 0.0)
    prev = sc.camera
    sc.camera = cam
    comp = sc.render.use_compositing
    sc.render.use_compositing = False
    sc.render.resolution_x, sc.render.resolution_y = 1024, 512
    sc.cycles.samples = 64
    exr = os.path.join(DIR, "env.exr")
    _render_to(exr, fmt="OPEN_EXR", depth="16", color="RGBA")
    sc.camera = prev
    sc.render.use_compositing = comp


def pass_motion():
    if not MOTION and not LIFT:
        return
    sc = bpy.context.scene
    comp = sc.render.use_compositing
    sc.render.use_compositing = False
    saved_world = sc.world
    sc.world = None
    hidden = []
    for name in AUX_HIDE:
        o = bpy.data.objects.get(name)
        if o and not o.hide_render:
            o.hide_render = True
            hidden.append(o)
    view, look = sc.view_settings.view_transform, sc.view_settings.look
    sc.view_settings.view_transform = "Raw" if "Raw" in [i.identifier for i in sc.view_settings.bl_rna.properties["view_transform"].enum_items] else "Standard"
    sc.view_settings.look = "None"
    samples, den, filt, bounces = sc.cycles.samples, sc.cycles.use_denoising, sc.cycles.filter_width, sc.cycles.max_bounces
    sc.cycles.samples, sc.cycles.use_denoising, sc.cycles.filter_width, sc.cycles.max_bounces = 12, False, 1.5, 0

    def number(t, v):
        n = t.nodes.new("ShaderNodeValue")
        n.outputs[0].default_value = float(v)
        return n.outputs[0]

    def math(t, op, a, b=None, clamp=False):
        n = t.nodes.new("ShaderNodeMath")
        n.operation = op
        n.use_clamp = clamp
        for i, v in enumerate((a, b)):
            if v is None:
                continue
            if isinstance(v, (int, float)):
                n.inputs[i].default_value = float(v)
            else:
                t.links.new(v, n.inputs[i])
        return n.outputs[0]

    def surface(mat):
        mat.use_nodes = True
        t = mat.node_tree
        t.nodes.clear()
        e = t.nodes.new("ShaderNodeEmission")
        o = t.nodes.new("ShaderNodeOutputMaterial")
        col = t.nodes.new("ShaderNodeCombineColor")
        t.links.new(col.outputs[0], e.inputs["Color"])
        t.links.new(e.outputs[0], o.inputs["Surface"])
        return t, col

    if MOTION:
        for mat in bpy.data.materials:
            if mat.name == "__depth" or mat.name.startswith("flat_"):
                continue
            t, col = surface(mat)
            spec = MOTION.get(mat.name)
            if not spec:
                continue
            axis = spec.get("axis")
            if axis == "object":
                tc = t.nodes.new("ShaderNodeTexCoord")
                sp = t.nodes.new("ShaderNodeSeparateXYZ")
                t.links.new(tc.outputs["Object"], sp.inputs[0])
                bend = math(t, "DIVIDE", sp.outputs["Z"], spec.get("h", 1.0))
                bend = math(t, "MULTIPLY", bend, spec.get("bend", 1.0), clamp=True)
            elif axis == "world":
                g = t.nodes.new("ShaderNodeNewGeometry")
                sp = t.nodes.new("ShaderNodeSeparateXYZ")
                t.links.new(g.outputs["Position"], sp.inputs[0])
                bend = math(t, "DIVIDE", math(t, "SUBTRACT", sp.outputs["Z"], spec.get("z0", 0.0)), spec.get("h", 1.0))
                bend = math(t, "MULTIPLY", bend, spec.get("bend", 1.0), clamp=True)
            else:
                bend = number(t, spec.get("bend", 0.0))
            t.links.new(bend, col.inputs[0])
            if spec.get("phase") == "object":
                info = t.nodes.new("ShaderNodeObjectInfo")
                t.links.new(info.outputs["Random"], col.inputs[1])
            else:
                g = t.nodes.new("ShaderNodeNewGeometry")
                nz = t.nodes.new("ShaderNodeTexNoise")
                nz.inputs["Scale"].default_value = float(spec.get("phase_scale", 2.5))
                t.links.new(g.outputs["Position"], nz.inputs["Vector"])
                t.links.new(nz.outputs[0], col.inputs[1])
            col.inputs[2].default_value = float(spec.get("run", 0.0))
        _res(1920)
        png = os.path.join(SCRATCH, "motion.png")
        _render_to(png)
        _webp(png, os.path.join(DIR, "plate_motion.webp"), q=90)

    if LIFT:
        for mat in bpy.data.materials:
            if mat.name == "__depth" or mat.name.startswith("flat_"):
                continue
            t, col = surface(mat)
            if mat.name in LIFT_SKIP:
                continue
            g = t.nodes.new("ShaderNodeNewGeometry")
            for i, zone in enumerate(LIFT):
                d = t.nodes.new("ShaderNodeVectorMath")
                d.operation = "DISTANCE"
                t.links.new(g.outputs["Position"], d.inputs[0])
                d.inputs[1].default_value = tuple(zone[:3])
                t.links.new(math(t, "LESS_THAN", d.outputs["Value"], zone[3]), col.inputs[i])
        _res(1024)
        png = os.path.join(SCRATCH, "lift.png")
        _render_to(png)
        _webp(png, os.path.join(DIR, "plate_lift.webp"), q=80)

    sc.cycles.samples, sc.cycles.use_denoising, sc.cycles.filter_width, sc.cycles.max_bounces = samples, den, filt, bounces
    sc.view_settings.view_transform, sc.view_settings.look = view, look
    for o in hidden:
        o.hide_render = False
    sc.world = saved_world
    sc.render.use_compositing = comp


def pass_aux():
    """Depth from the same camera with no blur, as 16 bit inverse depth, then the masks of the regions that stay alive."""
    sc = bpy.context.scene
    cam = sc.camera
    comp = sc.render.use_compositing
    sc.render.use_compositing = False
    saved_world = sc.world
    sc.world = None
    dof = cam.data.dof.use_dof
    cam.data.dof.use_dof = False
    hidden = []
    for name in AUX_HIDE:
        o = bpy.data.objects.get(name)
        if o and not o.hide_render:
            o.hide_render = True
            hidden.append(o)
    view, look = sc.view_settings.view_transform, sc.view_settings.look
    sc.view_settings.view_transform = "Raw" if "Raw" in [i.identifier for i in sc.view_settings.bl_rna.properties["view_transform"].enum_items] else "Standard"
    sc.view_settings.look = "None"

    # depth
    m = bpy.data.materials.new("__depth")
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    cd = nt.nodes.new("ShaderNodeCameraData")
    em = nt.nodes.new("ShaderNodeEmission")
    ou = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(cd.outputs["View Z Depth"], em.inputs["Color"])
    nt.links.new(em.outputs[0], ou.inputs["Surface"])
    vl = bpy.context.view_layer
    vl.material_override = m
    samples, den, filt, bounces, trans = sc.cycles.samples, sc.cycles.use_denoising, sc.cycles.filter_width, sc.cycles.max_bounces, sc.cycles.transparent_max_bounces
    clamp_d, clamp_i = sc.cycles.sample_clamp_direct, sc.cycles.sample_clamp_indirect
    # The clamps would cut every depth off at their value.
    sc.cycles.sample_clamp_direct, sc.cycles.sample_clamp_indirect = 0.0, 0.0
    sc.cycles.samples, sc.cycles.use_denoising, sc.cycles.filter_width, sc.cycles.max_bounces = 1, False, 0.01, 0
    W = 1600
    _res(W)
    exr = os.path.join(SCRATCH, "depth.exr")
    _render_to(exr, fmt="OPEN_EXR", depth="32", color="RGB")
    vl.material_override = None
    arr, w, h = _load_pixels(exr)
    z = arr[:, :, 0].copy()
    hit = z[z > 0]
    z_near = float(np.percentile(hit, 0.05)) * 0.8
    z_far = float(hit.max()) * 1.2 if hit.size else 1000.0
    # sky has no hit: it sits at the far end
    z[z <= 0] = z_far
    inv = (1.0 / z - 1.0 / z_far) / (1.0 / z_near - 1.0 / z_far)
    u16 = np.clip(np.round(inv * 65535.0), 0, 65535).astype("<u2")
    u16.tofile(os.path.join(DIR, "depth.bin"))
    NOTES["depth"] = dict(w=w, h=h, near=z_near, far=z_far)
    print("depth", w, h, z_near, z_far, flush=True)

    # masks: flat colours, with the blur back on so they line up with the plate
    cam.data.dof.use_dof = dof
    if MASKS:
        channel = {}
        for key, names in MASKS.items():
            i = dict(water=0, flow=1, pulse=2)[key]
            for n in names:
                channel.setdefault(n, [0.0, 0.0, 0.0])[i] = 1.0
        for mat in bpy.data.materials:
            if mat.name == "__depth" or mat.name.startswith("flat_"):
                continue
            mat.use_nodes = True
            t = mat.node_tree
            t.nodes.clear()
            e = t.nodes.new("ShaderNodeEmission")
            o = t.nodes.new("ShaderNodeOutputMaterial")
            c = channel.get(mat.name, [0.0, 0.0, 0.0])
            e.inputs["Color"].default_value = (*c, 1.0)
            t.links.new(e.outputs[0], o.inputs["Surface"])
        sc.cycles.samples = 16
        sc.cycles.filter_width = 1.5
        _res(1280)
        png = os.path.join(SCRATCH, "mask.png")
        _render_to(png)
        _webp(png, os.path.join(DIR, "plate_mask.webp"), q=85)
    sc.cycles.samples, sc.cycles.use_denoising, sc.cycles.filter_width, sc.cycles.max_bounces = samples, den, filt, bounces
    sc.cycles.sample_clamp_direct, sc.cycles.sample_clamp_indirect = clamp_d, clamp_i
    sc.view_settings.view_transform, sc.view_settings.look = view, look
    for o in hidden:
        o.hide_render = False
    sc.world = saved_world
    sc.render.use_compositing = comp


def _probe_colors(sock, depth=0):
    out = []
    if depth > 6 or not sock.is_linked:
        return out
    node = sock.links[0].from_node
    if node.type == "VALTORGB":
        out += [tuple(e.color[:3]) for e in node.color_ramp.elements]
    for inp in node.inputs:
        if inp.is_linked:
            out += _probe_colors(inp, depth + 1)
        elif inp.type == "RGBA":
            out.append(tuple(inp.default_value[:3]))
    return out


def _flat_material(m):
    name = m.name
    spec = FLATS.get(name) or FLATS.get(name.split(".")[0])
    new = bpy.data.materials.new("flat_" + name)
    new.use_nodes = True
    p = _principled(new)
    if spec:
        p.inputs["Base Color"].default_value = (*spec["color"], 1.0)
        p.inputs["Roughness"].default_value = spec["rough"]
        p.inputs["Metallic"].default_value = spec["metal"]
        if spec["emis"]:
            p.inputs["Emission Color"].default_value = (*spec["emis"], 1.0)
            p.inputs["Emission Strength"].default_value = spec["emis_str"]
        if spec.get("alpha", 1.0) < 1.0:
            p.inputs["Alpha"].default_value = spec["alpha"]
            new.blend_method = "BLEND"
        return new
    src = _principled(m)
    if src:
        for key in ("Roughness", "Metallic", "Emission Strength"):
            if not src.inputs[key].is_linked:
                p.inputs[key].default_value = src.inputs[key].default_value
        for key in ("Base Color", "Emission Color"):
            if not src.inputs[key].is_linked:
                p.inputs[key].default_value = src.inputs[key].default_value
            elif key == "Base Color":
                # The colours feeding the node tree, averaged. Far closer than the viewport's default grey.
                found = _probe_colors(src.inputs[key])
                mean = tuple(sum(c[i] for c in found) / len(found) for i in range(3)) if found else tuple(m.diffuse_color[:3])
                print("FLAT NEEDED: material", name, "has a procedural base colour. Using its average", [round(v, 3) for v in mean], "Add PT.flat() to set it exactly.", flush=True)
                p.inputs[key].default_value = (*mean, 1.0)
    return new


FLAT_COPIES = {}


def _prepare_flats():
    """Actor materials must be copied while the originals still have their nodes: the mask pass clears those."""
    for e in ACTORS.values():
        for o in _alive(e["objs"]):
            if o.type != "MESH" or not o.data.materials or not o.data.materials[0]:
                continue
            src = o.data.materials[0]
            if src.name not in FLAT_COPIES:
                FLAT_COPIES[src.name] = _flat_material(src)


def pass_actors():
    bpy.ops.object.select_all(action="DESELECT")
    bpy.context.view_layer.update()
    made = []
    summary = {}
    for name, e in ACTORS.items():
        objs = _alive(e["objs"])
        meshes = [o for o in objs if o.type == "MESH"]
        if not meshes:
            continue
        if e["pivot"] is None:
            lo = np.array([np.inf] * 3)
            hi = -lo
            for o in meshes:
                for c in o.bound_box:
                    w = np.array(o.matrix_world @ Vector(c))
                    lo, hi = np.minimum(lo, w), np.maximum(hi, w)
            e["pivot"] = tuple((lo + hi) / 2)
        root = bpy.data.objects.new("ACT_" + name, None)
        bpy.context.collection.objects.link(root)
        root.location = e["pivot"]
        made.append(root)
        faces = 0
        to_pivot = Matrix.Translation(-Vector(e["pivot"]))
        for i, o in enumerate(meshes):
            world = o.matrix_world.copy()
            o.data = o.data.copy()
            o.data.transform(to_pivot @ world)
            o.parent = None
            o.matrix_world = Matrix.Identity(4)
            o.parent = root
            o.matrix_parent_inverse = Matrix.Identity(4)
            o.matrix_local = Matrix.Identity(4)
            o.name = f"{name}_{i}"
            o.hide_render = False
            faces += len(o.data.polygons)
            if o.data.materials and o.data.materials[0]:
                src = o.data.materials[0]
                # Made before the masks wrecked the originals, see _prepare_flats.
                o.data.materials[0] = FLAT_COPIES.get(src.name) or _flat_material(src)
            made.append(o)
        if faces > FACE_BUDGET:
            for o in meshes:
                d = o.modifiers.new("dec", "DECIMATE")
                d.ratio = FACE_BUDGET / faces
        summary[name] = faces
    print("ACTORS", json.dumps(summary), flush=True)
    bpy.context.view_layer.update()
    for o in made:
        o.select_set(True)
    if made:
        bpy.ops.export_scene.gltf(
            filepath=os.path.join(DIR, "actors.glb"),
            export_format="GLB",
            use_selection=True,
            export_yup=True,
            export_apply=True,
            export_materials="EXPORT",
            export_cameras=False,
            export_lights=False,
            export_animations=False,
            export_skins=False,
            export_morph=False,
            export_texcoords=False,
            export_normals=True,
            export_tangents=False,
        )


def write_json(cam):
    sc = bpy.context.scene
    vl = bpy.context.view_layer
    vl.update()
    d = cam.data
    aspect = 16 / 9
    hfov = 2 * math.atan(d.sensor_width / 2 / d.lens)
    vfov = 2 * math.atan(math.tan(hfov / 2) / aspect)
    M = cam.matrix_world
    q = M.to_quaternion()
    # Blender z up to three y up is a turn of minus 90 degrees around x
    qx = Matrix.Rotation(-math.pi / 2, 4, "X").to_quaternion()
    q3 = qx @ q
    suns = []
    for o in bpy.data.objects:
        if o.type == "LIGHT" and o.data.type == "SUN" and not o.hide_render:
            to_light = o.matrix_world.to_quaternion() @ Vector((0, 0, 1))
            suns.append(dict(dir=to_three(to_light), color=list(o.data.color), energy=float(o.data.energy)))
    data = dict(
        camera=dict(pos=to_three(M.translation), quat=[q3.x, q3.y, q3.z, q3.w], vfov=math.degrees(vfov), hfov=math.degrees(hfov), lens=d.lens, sensor=d.sensor_width,
                    focus=float(d.dof.focus_distance), fstop=float(d.dof.aperture_fstop), dof=bool(d.dof.use_dof)),
        exposure=float(sc.view_settings.exposure),
        suns=suns, spots=SPOTS, paths=PATHS, bots=BOTS, groups=list(ACCENTS.keys()), **NOTES,
    )
    path_ = os.path.join(DIR, "plate.json")
    # Keep what an earlier run of other passes measured (depth range) when only some passes run this time.
    if os.path.exists(path_):
        try:
            old = json.load(open(path_))
            for key in ("depth",):
                if key in old and key not in data:
                    data[key] = old[key]
        except Exception:
            pass
    json.dump(data, open(path_, "w"), indent=1)


def finish(cam, env_center=None):
    sc = bpy.context.scene
    sc.camera = cam
    for o in _alive(_actor_objs()) + _alive(DROPPED):
        o.hide_render = True
        o.hide_viewport = False
    bpy.context.view_layer.update()
    if env_center is None:
        env_center = cam.matrix_world.translation + cam.matrix_world.to_quaternion() @ Vector((0, 0, -cam.data.dof.focus_distance))
    print("objects", len(bpy.data.objects), "faces", sum(len(m.polygons) for m in bpy.data.meshes), flush=True)
    _prepare_flats()
    # the masks wreck every material, so aux goes after anything that needs them. Actors go last: they move geometry.
    if "plate" in PASSES:
        pass_plate()
    if "accent" in PASSES:
        pass_accent()
    if "env" in PASSES:
        pass_env(env_center)
    if "aux" in PASSES:
        pass_aux()
    if "motion" in PASSES:
        pass_motion()
    if "actors" in PASSES:
        pass_actors()
    # The motion pass changes nothing the page's plate.json describes, and the json of a part run would lose what it did not run.
    if set(PASSES) != {"motion"}:
        write_json(cam)
    shutil.copy(os.path.join(os.path.dirname(os.path.abspath(__file__)), "agx_lut.bin"), os.path.join(DIR, "agx_lut.bin")) if os.path.exists(os.path.join(os.path.dirname(os.path.abspath(__file__)), "agx_lut.bin")) else None
    print("PLATE DONE", DIR, flush=True)
