"""Cycles still of the whole mascot family. Always run it through tools/render.sh.

tools/render.sh blender/shared/mascots_lineup.py look/mascots_v1.png 1920 200
Extra argument "wide" renders the family at about 50 px tall from a high island camera, on snow.
Extra argument "close" renders three bots large, to check the surface.
Extra argument "props" renders each job tool beside a bot, as the art pairs them.
Extra argument "props_far" is the same set from far enough that a bot is about 50 px tall at 960 wide.
"""
import math
import os
import sys

import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mascots as M

ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = ARGS[0] if ARGS else "/tmp/mascots.png"
WIDTH = int(ARGS[1]) if len(ARGS) > 1 else 1280
SAMPLES = int(ARGS[2]) if len(ARGS) > 2 else 48
MODE = ARGS[3] if len(ARGS) > 3 else "lineup"

for o in list(bpy.data.objects):
    bpy.data.objects.remove(o)
sc = bpy.context.scene


def principled(name, base, rough=0.5, coat=0.0, coat_rough=0.05, sss=0.0, sss_scale=0.05, sss_radius=(1.0, 0.6, 0.4)):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    n = m.node_tree.nodes["Principled BSDF"]
    n.inputs["Base Color"].default_value = (*base, 1)
    n.inputs["Roughness"].default_value = rough
    n.inputs["Coat Weight"].default_value = coat
    n.inputs["Coat Roughness"].default_value = coat_rough
    if sss:
        n.inputs["Subsurface Weight"].default_value = sss
        n.inputs["Subsurface Radius"].default_value = sss_radius
        n.inputs["Subsurface Scale"].default_value = sss_scale
    return m


def agx_base(hex_color):
    """AgX pulls strong colour towards pastel, so push the base colour a little past the art."""
    r, g, b = M.srgb_to_linear(hex_color)
    top = max(r, g, b, 1e-4)
    low = min(r, g, b)
    if top - low < 0.04:
        return (r, g, b)
    return tuple(top * (v / top) ** 1.28 for v in (r, g, b))


EYE = principled("eye", M.EYE_MATERIAL["base"], M.EYE_MATERIAL["roughness"], M.EYE_MATERIAL["coat"], M.EYE_MATERIAL["coat_roughness"])


def body_mat(name, hex_color, size):
    g = M.GLOSSY
    return principled(name, agx_base(hex_color), g["roughness"], g["coat"], g["coat_roughness"], g["sss"], g["sss_scale"] * size)


def mesh_obj(name, V, F, mat):
    me = bpy.data.meshes.new(name)
    me.from_pydata(V, [], F)
    me.polygons.foreach_set("use_smooth", [True] * len(F))
    me.update()
    me.materials.append(mat)
    o = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(o)
    return o


def add_bot(shape, hex_color, base, size=1.0, facing=0.0, pitch=0.0, detail="film", tag=None):
    tag = tag or shape
    m = M.placed_mesh(shape, size=size, base=base, facing=facing, pitch=pitch, detail=detail)
    mesh_obj("bot_" + tag, m["body_v"], m["body_f"], body_mat("mat_" + tag, hex_color, size))
    mesh_obj("eyes_" + tag, m["eye_v"], m["eye_f"], EYE)
    return m


def area(loc, target, size, size_y, power, color=(1, 1, 1)):
    l = bpy.data.lights.new("a", "AREA")
    l.shape = "RECTANGLE"
    l.size = size
    l.size_y = size_y
    l.energy = power
    l.color = color
    o = bpy.data.objects.new("a", l)
    bpy.context.collection.objects.link(o)
    o.location = loc
    d = (target[0] - loc[0], target[1] - loc[1], target[2] - loc[2])
    o.rotation_mode = "QUATERNION"
    from mathutils import Vector
    o.rotation_quaternion = Vector(d).to_track_quat("-Z", "Y")
    return o


def camera(loc, target, lens):
    from mathutils import Vector
    c = bpy.data.cameras.new("cam")
    c.lens = lens
    c.sensor_width = 36
    o = bpy.data.objects.new("cam", c)
    bpy.context.collection.objects.link(o)
    o.location = loc
    o.rotation_mode = "QUATERNION"
    o.rotation_quaternion = Vector((target[0] - loc[0], target[1] - loc[1], target[2] - loc[2])).to_track_quat("-Z", "Y")
    sc.camera = o
    return o


def sweep(mat, y_back=7.0, radius=4.0, height=14.0, half_w=40.0, y_front=-40.0):
    """A photographer's seamless: floor, curve, wall."""
    prof = [(y_front, 0.0), (y_back - radius, 0.0)]
    for k in range(1, 25):
        t = 0.5 * math.pi * k / 24
        prof.append((y_back - radius + radius * math.sin(t), radius - radius * math.cos(t)))
    prof.append((y_back, height))
    V, F = [], []
    for y, z in prof:
        V.append((-half_w, y, z))
        V.append((half_w, y, z))
    for i in range(len(prof) - 1):
        F.append((2 * i, 2 * i + 1, 2 * i + 3, 2 * i + 2))
    mesh_obj("sweep", V, F, mat)


def faces_camera(base, cam_xy, extra=0.0):
    return math.atan2(cam_xy[0] - base[0], -(cam_xy[1] - base[1])) + extra


W = bpy.data.worlds.new("w")
W.use_nodes = True
sc.world = W
bg = W.node_tree.nodes["Background"]

P = M.PALETTE
LIGHT = 1.0
if MODE in ("props", "props_far"):
    # Two rows from a raised camera, the lineup's dark floor, and brighter lights than the lineup.
    LIGHT = 2.8
    bg.inputs[0].default_value = (0.13, 0.15, 0.2, 1)
    bg.inputs[1].default_value = 0.3
    sweep(principled("floor", (0.016, 0.017, 0.021), 0.5), y_back=11.0)
    mats = {}
    for key, spec in M.PROP_MATERIALS.items():
        mats[key] = principled(key, M.prop_base(key), spec["roughness"], spec["coat"], spec["coat_roughness"], spec["sss"], spec["sss_scale"])
        mats[key].node_tree.nodes["Principled BSDF"].inputs["Metallic"].default_value = spec["metal"]
    row = [("magnifier", "triangle", P["triangle"]), ("calendar", "cloud", P["cloud_red"]), ("megaphone", "star", P["star"]), ("camera", "squircle", P["squircle"]),
           ("funnel", "cloud", P["cloud_teal"]), ("magnet", "pentagon", P["pentagon"]), ("chart", "drop", P["drop"]), ("wrench", "hexagon", P["hexagon"])]
    cam_loc = (0.0, -15.2, 5.8)
    for i, (tool, shape, col) in enumerate(row):
        x = ((i % 4) - 1.5) * 1.82
        y = 1.75 if i < 4 else -1.75
        b = (x, y, 0.0)
        facing = faces_camera(b, cam_loc[:2], math.radians(4))
        add_bot(shape, col, b, 1.0, facing, math.radians(-12), tag="%s_%d" % (shape, i))
        for j, part in enumerate(M.placed_prop(tool, shape=shape, size=1.0, base=b, facing=facing, pitch=math.radians(-12))):
            mesh_obj("%s_%d" % (tool, j), part["v"], part["f"], mats[part["mat"]])
    camera(cam_loc, (0.0, 0.0, 0.4), 30 if MODE == "props_far" else 71)
    sc.render.resolution_x = WIDTH
    sc.render.resolution_y = int(WIDTH * 0.42)
elif MODE == "wide":
    # A high island camera, snow ground, soft warm sun: is every shape still itself at 50 px?
    bg.inputs[0].default_value = (0.32, 0.42, 0.62, 1)
    bg.inputs[1].default_value = 0.55
    snow = principled("snow", (0.72, 0.77, 0.86), 0.7)
    mesh_obj("g", [(-90, -90, 0), (90, -90, 0), (90, 90, 0), (-90, 90, 0)], [(0, 1, 2, 3)], snow)
    sun = bpy.data.lights.new("s", "SUN")
    sun.energy = 2.4
    sun.color = (1.0, 0.72, 0.5)
    sun.angle = math.radians(8)
    so = bpy.data.objects.new("s", sun)
    bpy.context.collection.objects.link(so)
    so.rotation_euler = (math.radians(58), 0, math.radians(-40))
    cam_xy = (0.0, -38.0)
    order = [("sphere", P["lead"]), ("cloud", P["cloud"]), ("triangle", P["triangle"]), ("star", P["star"]), ("star4", P["star4"]),
             ("squircle", P["squircle"]), ("pentagon", P["pentagon"]), ("drop", P["drop"]), ("hexagon", P["hexagon"]), ("capsule", P["capsule"]), ("sphere", P["sphere"])]
    for i, (shape, col) in enumerate(order):
        x = (i - (len(order) - 1) / 2) * 3.1
        b = (x, 0.0, 0.0)
        add_bot(shape, col, b, 1.0, faces_camera(b, cam_xy), math.radians(-8), detail="film", tag="%s_%d" % (shape, i))
    camera((0.0, -38.0, 25.0), (0.0, 0.0, 0.5), 28.9)
    sc.render.resolution_x = WIDTH
    sc.render.resolution_y = int(WIDTH * 0.2)
else:
    bg.inputs[0].default_value = (0.13, 0.15, 0.2, 1)
    bg.inputs[1].default_value = 0.22
    floor = principled("floor", (0.016, 0.017, 0.021), 0.34)
    sweep(floor)
    if MODE == "close":
        cam_xy = (0.0, -11.0)
        items = [("star", P["star"], -1.75, 1.0), ("sphere", P["lead"], 0.0, 1.15), ("cloud", P["cloud"], 1.8, 1.0)]
        for shape, col, x, s in items:
            b = (x, 0.0, 0.0)
            add_bot(shape, col, b, s, faces_camera(b, cam_xy, math.radians(5)), math.radians(-4), tag="%s_c" % shape)
        camera((0.0, -11.0, 1.9), (0.0, 0.0, 0.62), 86)
        sc.render.resolution_y = int(WIDTH * 0.42)
    else:
        cam_xy = (0.0, -17.0)
        riser_h = 1.34
        riser = principled("riser", (0.022, 0.023, 0.028), 0.3)
        bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 2.1, riser_h / 2))
        r_o = bpy.context.active_object
        r_o.scale = (30, 2.6, riser_h)
        bpy.ops.object.transform_apply(scale=True)
        bv = r_o.modifiers.new("bv", "BEVEL")
        bv.width = 0.18
        bv.segments = 10
        r_o.data.materials.append(riser)
        for p in r_o.data.polygons:
            p.use_smooth = True
        back = [("cloud", P["cloud"]), ("triangle", P["triangle"]), ("star", P["star"]), ("sphere", P["sphere"]),
                ("star4", P["star4"]), ("squircle", P["squircle"])]
        front = [("pentagon", P["pentagon"]), ("drop", P["drop"]), ("sphere", P["lead"]), ("hexagon", P["hexagon"]), ("capsule", P["capsule"])]
        for i, (shape, col) in enumerate(back):
            x = (i - 2.5) * 1.62
            b = (x, 1.95, riser_h)
            add_bot(shape, col, b, 1.0, faces_camera(b, cam_xy, math.radians(4)), math.radians(-5), tag="back_%d" % i)
        for i, (shape, col) in enumerate(front):
            x = (i - 2.0) * 1.86
            lead = i == 2
            s = 1.22 if lead else 1.05
            b = (x, -0.45, 0.0)
            add_bot(shape, col, b, s, faces_camera(b, cam_xy, math.radians(4)), math.radians(-5), tag="front_%d" % i)
        camera((0.0, -17.0, 3.1), (0.0, 0.0, 1.22), 62)
        sc.render.resolution_y = int(WIDTH * 9 / 16)
    sc.render.resolution_x = WIDTH

if MODE != "wide":
    # The art is lit by long soft boxes: broad top left, thin streaks along the edges.
    area((-6.5, -7.0, 8.0), (0, 0, 1), 7, 5, 520 * LIGHT, (1.0, 0.97, 0.94))
    area((-10.0, -3.5, 2.6), (0, 0, 1), 0.9, 9, 240 * LIGHT, (0.95, 0.97, 1.0))
    area((9.5, -3.0, 4.2), (0, 0, 1), 1.2, 8, 150 * LIGHT, (0.82, 0.85, 1.0))
    area((0.0, 2.0, 9.5), (0, 0, 1), 12, 2.4, 190 * LIGHT, (1.0, 0.98, 0.96))
    area((0.0, -14.0, 0.6), (0, 0, 1.2), 10, 1.0, 22 * LIGHT, (1.0, 0.95, 0.92))

sc.render.engine = "CYCLES"
prefs = bpy.context.preferences.addons["cycles"].preferences
prefs.compute_device_type = "METAL"
prefs.get_devices()
for d in prefs.devices:
    d.use = True
sc.cycles.device = "GPU"
sc.cycles.samples = SAMPLES
sc.cycles.use_denoising = True
sc.cycles.denoiser = "OPENIMAGEDENOISE"
sc.cycles.max_bounces = 8
sc.render.film_transparent = False
sc.view_settings.view_transform = "AgX"
sc.view_settings.look = "AgX - Punchy"
sc.view_settings.exposure = 0.45
sc.render.image_settings.file_format = "PNG"
sc.render.filepath = OUT
print("objects", len(bpy.data.objects))
bpy.ops.render.render(write_still=True)
print("DONE", OUT)
