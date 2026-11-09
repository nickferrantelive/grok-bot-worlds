"""Chrome Citadel: three bots building a mirror ring on the top of a white spiral hill.

The line: steel coils and a foundry by the pool, polished panels loaded onto maglev pods, pods climbing the
spiral ramp, an inspection terrace part way up, and the white lead fitting panels into an unfinished ring.

Run through tools/render.sh only:
  tools/render.sh blender/chrome-citadel/island_look.py <out.png> <width> <samples> [save.blend] [--cam foundry|terrace|summit]
--cam moves in on one station to check detail. Colours and shapes live in BOTS.
The earlier hub layout is kept in island_hub_v1_snapshot.py.
"""
import math
import os
import random
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector, noise

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "shared"))
import mascots
import plate_tools as PT
from contextlib import nullcontext

ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
FLAGS = {}
POS = []
_i = 0
while _i < len(ARGS):
    if ARGS[_i].startswith("--") and _i + 1 < len(ARGS):
        FLAGS[ARGS[_i][2:]] = ARGS[_i + 1]
        _i += 2
    else:
        POS.append(ARGS[_i])
        _i += 1
OUT = POS[0] if POS else "/tmp/citadel.png"
WIDTH = int(POS[1]) if len(POS) > 1 else 1280
SAMPLES = int(POS[2]) if len(POS) > 2 else 48
SAVE = POS[3] if len(POS) > 3 else None
PT.setup(ARGS, globals())

random.seed(11)
np.random.seed(11)
PI = math.pi
TAU = 2 * math.pi

for o in list(bpy.data.objects):
    bpy.data.objects.remove(o)


# ---------- materials ----------
def pbsdf(name, base=(0.5, 0.5, 0.5), rough=0.5, metal=0.0, emis=None, emis_str=0.0, coat=0.0, coat_rough=0.05, sss=0.0, sss_scale=0.05):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    n = m.node_tree.nodes["Principled BSDF"]
    n.inputs["Base Color"].default_value = (*base, 1)
    n.inputs["Roughness"].default_value = rough
    n.inputs["Metallic"].default_value = metal
    n.inputs["Coat Weight"].default_value = coat
    n.inputs["Coat Roughness"].default_value = coat_rough
    if sss:
        n.inputs["Subsurface Weight"].default_value = sss
        n.inputs["Subsurface Radius"].default_value = (0.5, 0.75, 1.0)
        n.inputs["Subsurface Scale"].default_value = sss_scale
    if emis:
        n.inputs["Emission Color"].default_value = (*emis, 1)
        n.inputs["Emission Strength"].default_value = emis_str
    return m


def _math(nt, op, a=None, b=None):
    n = nt.nodes.new("ShaderNodeMath")
    n.operation = op
    for i, v in enumerate((a, b)):
        if v is None:
            continue
        if isinstance(v, (int, float)):
            n.inputs[i].default_value = v
        else:
            nt.links.new(v, n.inputs[i])
    return n.outputs[0]


def _mix(nt, a, b, fac, blend="MIX"):
    n = nt.nodes.new("ShaderNodeMix")
    n.data_type = "RGBA"
    n.blend_type = blend
    for key, v in (("A", a), ("B", b)):
        if isinstance(v, tuple):
            n.inputs[key].default_value = v
        else:
            nt.links.new(v, n.inputs[key])
    if isinstance(fac, (int, float)):
        n.inputs["Factor"].default_value = fac
    else:
        nt.links.new(fac, n.inputs["Factor"])
    return n.outputs["Result"]


def _range(nt, v, a, b, c=0.0, d=1.0):
    n = nt.nodes.new("ShaderNodeMapRange")
    n.clamp = True
    nt.links.new(v, n.inputs["Value"])
    n.inputs["From Min"].default_value = a
    n.inputs["From Max"].default_value = b
    n.inputs["To Min"].default_value = c
    n.inputs["To Max"].default_value = d
    return n.outputs[0]


def mat_stone(name, base=(0.78, 0.77, 0.74), rough=0.42, seam=0.22, tone=0.1, coat=0.0, stain=True, grain=0.25, width=0.03):
    """White cladding: panel joints and tone from the puv attribute, soft staining from world position."""
    m = pbsdf(name, base, rough, coat=coat)
    nt = m.node_tree
    p = nt.nodes["Principled BSDF"]
    a = nt.nodes.new("ShaderNodeAttribute")
    a.attribute_name = "puv"
    sp = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(a.outputs["Vector"], sp.inputs[0])

    def dist(ch):
        return _math(nt, "ABSOLUTE", _math(nt, "SUBTRACT", _math(nt, "FRACT", ch), 0.5))

    du, dv = dist(sp.outputs[0]), dist(sp.outputs[1])
    mn = _math(nt, "MINIMUM", du, dv)
    jt = _range(nt, mn, width * 0.5, width, 1.0, 0.0)
    cu = _math(nt, "FLOOR", _math(nt, "ADD", sp.outputs[0], 0.5))
    cv = _math(nt, "FLOOR", _math(nt, "ADD", sp.outputs[1], 0.5))
    cb = nt.nodes.new("ShaderNodeCombineXYZ")
    nt.links.new(cu, cb.inputs[0])
    nt.links.new(cv, cb.inputs[1])
    wn = nt.nodes.new("ShaderNodeTexWhiteNoise")
    wn.noise_dimensions = "3D"
    nt.links.new(cb.outputs[0], wn.inputs["Vector"])
    t = _range(nt, wn.outputs["Value"], 0.0, 1.0, 1.0 - tone, 1.0)
    g = nt.nodes.new("ShaderNodeNewGeometry")
    nz = nt.nodes.new("ShaderNodeTexNoise")
    nz.inputs["Scale"].default_value = 1.6
    nz.inputs["Detail"].default_value = 6
    nz.inputs["Roughness"].default_value = 0.6
    nt.links.new(g.outputs["Position"], nz.inputs["Vector"])
    soft = _range(nt, nz.outputs["Fac"], 0.34, 0.68, 0.9, 1.0)
    c = _mix(nt, (*base, 1), (1, 1, 1, 1), 0.0)
    tt = _math(nt, "MULTIPLY", t, soft)
    c2 = nt.nodes.new("ShaderNodeVectorMath")
    c2.operation = "SCALE"
    nt.links.new(c, c2.inputs[0])
    nt.links.new(tt, c2.inputs["Scale"])
    col = c2.outputs[0]
    if stain:
        sz = nt.nodes.new("ShaderNodeSeparateXYZ")
        nt.links.new(g.outputs["Position"], sz.inputs[0])
        st = _range(nt, sz.outputs[2], 0.015, 0.2, 1.0, 0.0)
        col = _mix(nt, col, (0.3, 0.33, 0.28, 1), st, "MULTIPLY")
    col = _mix(nt, col, (seam, seam, seam, 1), jt, "MULTIPLY")
    nt.links.new(col, p.inputs["Base Color"])
    fine = nt.nodes.new("ShaderNodeTexNoise")
    fine.inputs["Scale"].default_value = 90
    fine.inputs["Detail"].default_value = 4
    nt.links.new(g.outputs["Position"], fine.inputs["Vector"])
    b = nt.nodes.new("ShaderNodeBump")
    b.inputs["Strength"].default_value = grain
    b.inputs["Distance"].default_value = 0.006
    nt.links.new(fine.outputs["Fac"], b.inputs["Height"])
    b2 = nt.nodes.new("ShaderNodeBump")
    b2.inputs["Strength"].default_value = 0.9
    b2.inputs["Distance"].default_value = 0.012
    nt.links.new(_math(nt, "SUBTRACT", 1.0, jt), b2.inputs["Height"])
    nt.links.new(b.outputs["Normal"], b2.inputs["Normal"])
    nt.links.new(b2.outputs["Normal"], p.inputs["Normal"])
    return m


def mat_chrome(name="chrome", base=(0.93, 0.94, 0.96), rough=0.045, spread=0.1):
    """Stainless panels: puv.x carries a random per panel, so each one holds the sky a little differently."""
    m = pbsdf(name, base, rough, metal=1.0)
    nt = m.node_tree
    p = nt.nodes["Principled BSDF"]
    a = nt.nodes.new("ShaderNodeAttribute")
    a.attribute_name = "puv"
    sp = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(a.outputs["Vector"], sp.inputs[0])
    nt.links.new(_range(nt, sp.outputs[0], 0.0, 1.0, rough, rough + spread), p.inputs["Roughness"])
    return m


def mat_glazing():
    """Ribbon windows: dark sky-holding glass, thin white mullions, some panes warm with life inside."""
    m = pbsdf("glazing", (0.012, 0.022, 0.032), 0.06, coat=1.0, coat_rough=0.02)
    nt = m.node_tree
    p = nt.nodes["Principled BSDF"]
    a = nt.nodes.new("ShaderNodeAttribute")
    a.attribute_name = "puv"
    sp = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(a.outputs["Vector"], sp.inputs[0])
    d = _math(nt, "ABSOLUTE", _math(nt, "SUBTRACT", _math(nt, "FRACT", sp.outputs[0]), 0.5))
    mu = _range(nt, d, 0.09, 0.14, 1.0, 0.0)
    cu = _math(nt, "FLOOR", _math(nt, "ADD", sp.outputs[0], 0.5))
    cb = nt.nodes.new("ShaderNodeCombineXYZ")
    nt.links.new(cu, cb.inputs[0])
    wn = nt.nodes.new("ShaderNodeTexWhiteNoise")
    nt.links.new(cb.outputs[0], wn.inputs["Vector"])
    warm = _range(nt, wn.outputs["Value"], 0.84, 0.85, 0.0, 1.0)
    nt.links.new(_mix(nt, (0.012, 0.024, 0.036, 1), (0.8, 0.82, 0.84, 1), mu), p.inputs["Base Color"])
    p.inputs["Emission Color"].default_value = (1.0, 0.6, 0.28, 1)
    nt.links.new(_math(nt, "MULTIPLY", warm, 1.7), p.inputs["Emission Strength"])
    return m


def mat_trencadis():
    """The broken white tile from the Valencia planters."""
    m = pbsdf("trencadis", (0.82, 0.81, 0.77), 0.3, coat=0.3)
    nt = m.node_tree
    p = nt.nodes["Principled BSDF"]
    g = nt.nodes.new("ShaderNodeNewGeometry")
    v = nt.nodes.new("ShaderNodeTexVoronoi")
    v.feature = "DISTANCE_TO_EDGE"
    v.inputs["Scale"].default_value = 26
    nt.links.new(g.outputs["Position"], v.inputs["Vector"])
    e = _range(nt, v.outputs["Distance"], 0.0, 0.06, 1.0, 0.0)
    nt.links.new(_mix(nt, (0.82, 0.81, 0.77, 1), (0.16, 0.15, 0.14, 1), e), p.inputs["Base Color"])
    return m


def mat_leaf(name, c1, c2, scale=42.0, bump=1.0, rough=0.75):
    m = pbsdf(name, c1, rough)
    nt = m.node_tree
    p = nt.nodes["Principled BSDF"]
    tc = nt.nodes.new("ShaderNodeNewGeometry")
    v = nt.nodes.new("ShaderNodeTexNoise")
    v.inputs["Scale"].default_value = scale
    v.inputs["Detail"].default_value = 6
    v.inputs["Roughness"].default_value = 0.62
    nt.links.new(tc.outputs["Position"], v.inputs["Vector"])
    nt.links.new(_mix(nt, (*c1, 1), (*c2, 1), _range(nt, v.outputs["Fac"], 0.34, 0.68)), p.inputs["Base Color"])
    b = nt.nodes.new("ShaderNodeBump")
    b.inputs["Strength"].default_value = bump
    b.inputs["Distance"].default_value = 0.08
    nt.links.new(v.outputs["Fac"], b.inputs["Height"])
    nt.links.new(b.outputs["Normal"], p.inputs["Normal"])
    return m


def mat_water(name, deep, shallow, refl=0.55, tile=0.9):
    """A pool floor seen through still water, with the sky held on top."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    g = nt.nodes.new("ShaderNodeNewGeometry")
    sp = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(g.outputs["Position"], sp.inputs[0])

    def line(ch):
        return _math(nt, "ABSOLUTE", _math(nt, "SUBTRACT", _math(nt, "FRACT", _math(nt, "DIVIDE", ch, tile)), 0.5))

    jt = _range(nt, _math(nt, "MINIMUM", line(sp.outputs[0]), line(sp.outputs[1])), 0.008, 0.02, 1.0, 0.0)
    nz = nt.nodes.new("ShaderNodeTexNoise")
    nz.inputs["Scale"].default_value = 0.22
    nz.inputs["Detail"].default_value = 5
    nt.links.new(g.outputs["Position"], nz.inputs["Vector"])
    fl = _mix(nt, (*deep, 1), (*shallow, 1), _range(nt, nz.outputs["Fac"], 0.35, 0.68))
    fl = _mix(nt, fl, (0.5, 0.56, 0.58, 1), _math(nt, "MULTIPLY", jt, 1.0), "MULTIPLY")
    dif = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(fl, dif.inputs["Base Color"])
    dif.inputs["Roughness"].default_value = 0.6
    dif.inputs["Specular IOR Level"].default_value = 0.0
    glo = nt.nodes.new("ShaderNodeBsdfPrincipled")
    glo.inputs["Base Color"].default_value = (0.9, 0.97, 1.0, 1)
    glo.inputs["Metallic"].default_value = 1.0
    glo.inputs["Roughness"].default_value = 0.0
    mp = nt.nodes.new("ShaderNodeMapping")
    mp.inputs["Scale"].default_value = (1.0, 2.6, 1.0)
    nt.links.new(g.outputs["Position"], mp.inputs["Vector"])
    rp = nt.nodes.new("ShaderNodeTexNoise")
    rp.inputs["Scale"].default_value = 3.2
    rp.inputs["Detail"].default_value = 3
    nt.links.new(mp.outputs[0], rp.inputs["Vector"])
    b = nt.nodes.new("ShaderNodeBump")
    b.inputs["Strength"].default_value = 0.005
    b.inputs["Distance"].default_value = 0.1
    nt.links.new(rp.outputs["Fac"], b.inputs["Height"])
    nt.links.new(b.outputs["Normal"], glo.inputs["Normal"])
    lw = nt.nodes.new("ShaderNodeLayerWeight")
    lw.inputs["Blend"].default_value = 0.35
    fac = _range(nt, lw.outputs["Fresnel"], 0.0, 1.0, refl, 0.96)
    ms = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(fac, ms.inputs[0])
    nt.links.new(dif.outputs[0], ms.inputs[1])
    nt.links.new(glo.outputs[0], ms.inputs[2])
    nt.links.new(ms.outputs[0], out.inputs["Surface"])
    return m


def mat_halo(name, col, power=1.6, gain=3.0):
    """A soft shell around a flashing ring: bright at the core, gone at the rim, so colour survives AgX."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    lw = nt.nodes.new("ShaderNodeLayerWeight")
    lw.inputs["Blend"].default_value = 0.5
    f = _math(nt, "POWER", _math(nt, "SUBTRACT", 1.0, lw.outputs["Facing"]), power)
    em = nt.nodes.new("ShaderNodeEmission")
    em.inputs["Color"].default_value = (*col, 1)
    nt.links.new(_math(nt, "MULTIPLY", f, gain), em.inputs["Strength"])
    tr = nt.nodes.new("ShaderNodeBsdfTransparent")
    ad = nt.nodes.new("ShaderNodeAddShader")
    nt.links.new(em.outputs[0], ad.inputs[0])
    nt.links.new(tr.outputs[0], ad.inputs[1])
    nt.links.new(ad.outputs[0], out.inputs["Surface"])
    return m


MATS = dict(
    white=mat_stone("white", (0.84, 0.83, 0.8), 0.46, seam=0.34, tone=0.1),
    white2=mat_stone("white2", (0.9, 0.89, 0.87), 0.3, seam=0.4, tone=0.06, coat=0.25, grain=0.1),
    rimstone=mat_stone("rimstone", (0.8, 0.78, 0.73), 0.6, seam=0.45, tone=0.14),
    deck=mat_stone("deck", (0.84, 0.82, 0.78), 0.6, seam=0.58, tone=0.1, stain=False, width=0.03),
    chrome=mat_chrome(spread=0.045),
    chrome2=mat_chrome("chrome2", (0.74, 0.76, 0.8), 0.09, 0.14),
    steel=pbsdf("steel", (0.62, 0.64, 0.68), 0.3, metal=1.0),
    seamdark=pbsdf("seamdark", (0.02, 0.022, 0.026), 0.55),
    glazing=mat_glazing(),
    solar=pbsdf("solar", (0.016, 0.03, 0.07), 0.16, coat=1.0),
    graphite=pbsdf("graphite", (0.012, 0.013, 0.017), 0.16, coat=1.0, coat_rough=0.03),
    rail=pbsdf("rail", (0.5, 0.52, 0.55), 0.35, metal=1.0),
    trencadis=mat_trencadis(),
    lawn=mat_leaf("lawn", (0.16, 0.34, 0.07), (0.28, 0.44, 0.1), scale=9, bump=0.25, rough=0.9),
    hedge=mat_leaf("hedge", (0.03, 0.13, 0.03), (0.08, 0.25, 0.05), scale=60, bump=1.2),
    cypress=mat_leaf("cypress", (0.012, 0.07, 0.03), (0.05, 0.16, 0.05), scale=38, bump=1.4),
    olive=mat_leaf("olive", (0.12, 0.2, 0.09), (0.36, 0.42, 0.24), scale=16, bump=1.3),
    soil=pbsdf("soil", (0.03, 0.02, 0.014), 0.95),
    trunk=pbsdf("trunk", (0.09, 0.06, 0.04), 0.8),
    lily=mat_leaf("lily", (0.02, 0.16, 0.04), (0.09, 0.3, 0.07), scale=30, bump=0.3, rough=0.32),
    petal=pbsdf("petal", (0.98, 0.42, 0.62), 0.5, emis=(1.0, 0.25, 0.45), emis_str=0.25),
    petal2=pbsdf("petal2", (0.95, 0.93, 0.86), 0.5, emis=(1.0, 0.9, 0.7), emis_str=0.2),
    wood=pbsdf("wood", (0.38, 0.2, 0.09), 0.5, coat=0.3),
    lamp=pbsdf("lamp", (0, 0, 0), 0.3, emis=(1.0, 0.62, 0.3), emis_str=3.2),
    beacon=pbsdf("beacon", (0, 0, 0), 0.3, emis=(1.0, 0.07, 0.04), emis_str=7),
    pod=pbsdf("pod", (0.86, 0.87, 0.88), 0.14, coat=1.0, coat_rough=0.02),
    podglass=pbsdf("podglass", (0.01, 0.02, 0.03), 0.05, coat=1.0),
    eye=pbsdf("eye", mascots.EYE_MATERIAL["base"], mascots.EYE_MATERIAL["roughness"], coat=mascots.EYE_MATERIAL["coat"], coat_rough=mascots.EYE_MATERIAL["coat_roughness"]),
    pool=mat_water("pool", (0.006, 0.05, 0.085), (0.012, 0.095, 0.125), refl=0.5),
    shelf=mat_water("shelf", (0.03, 0.42, 0.42), (0.07, 0.55, 0.5), refl=0.14, tile=0.45),
    shelf2=mat_water("shelf2", (0.012, 0.2, 0.27), (0.03, 0.3, 0.34), refl=0.3, tile=0.45),
    rill=pbsdf("rill", (0.04, 0.3, 0.32), 0.03, coat=1.0),
)


# ---------- geometry ----------
class Geo:
    def __init__(self):
        self.d = {}
        self.skip = False

    def add(self, mat, V, F, S, uv=None):
        if self.skip:
            return
        mat = CUR.get(mat, mat)
        V = np.asarray(V, dtype=np.float64)
        e = self.d.setdefault(mat, dict(v=[], f=[], s=[], uv=[], n=0))
        e["v"].append(V)
        n = e["n"]
        e["f"].extend([tuple(i + n for i in f) for f in F])
        e["s"].extend(S)
        e["uv"].append(np.zeros((len(V), 2)) if uv is None else np.asarray(uv, dtype=np.float64))
        e["n"] = n + len(V)

    def build(self):
        for mat, e in self.d.items():
            V = np.concatenate(e["v"])
            me = bpy.data.meshes.new(mat)
            me.from_pydata(V.tolist(), [], e["f"])
            me.polygons.foreach_set("use_smooth", e["s"])
            uv = np.concatenate(e["uv"])
            if np.any(uv):
                a = me.attributes.new("puv", "FLOAT_VECTOR", "POINT")
                fl = np.zeros(len(V) * 3, dtype=np.float32)
                fl[0::3] = uv[:, 0]
                fl[1::3] = uv[:, 1]
                a.data.foreach_set("vector", fl)
            me.update()
            me.materials.append(MATS[mat])
            bpy.context.collection.objects.link(bpy.data.objects.new(mat, me))


CUR = {}
G = Geo()
_box = {}


def _rot(rz=0.0, rx=0.0, ry=0.0):
    return np.array((Matrix.Rotation(rz, 3, "Z") @ Matrix.Rotation(ry, 3, "Y") @ Matrix.Rotation(rx, 3, "X")))


def box(mat, c, size, r=0.012, rz=0.0, rx=0.0, ry=0.0, seg=2):
    sx, sy, sz = size
    r = min(r, min(size) * 0.45)
    key = (round(sx, 4), round(sy, 4), round(sz, 4), round(r, 4), seg)
    if key not in _box:
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=1.0)
        for v in bm.verts:
            v.co = Vector((v.co.x * sx, v.co.y * sy, v.co.z * sz))
        if r > 1e-5:
            bmesh.ops.bevel(bm, geom=bm.verts[:] + bm.edges[:], offset=r, offset_type="OFFSET", segments=seg, profile=0.5, affect="EDGES", clamp_overlap=True)
        bm.normal_update()
        V = np.array([v.co[:] for v in bm.verts])
        idx = {v: i for i, v in enumerate(bm.verts)}
        F = [tuple(idx[v] for v in f.verts) for f in bm.faces]
        S = [max(abs(f.normal.x), abs(f.normal.y), abs(f.normal.z)) < 0.999 for f in bm.faces]
        bm.free()
        _box[key] = (V, F, S)
    V, F, S = _box[key]
    G.add(mat, V @ _rot(rz, rx, ry).T + np.asarray(c), F, S)


def cyl(mat, a, b, r, seg=10, cap=True, r2=None):
    a, b = np.asarray(a, float), np.asarray(b, float)
    d = b - a
    d /= np.linalg.norm(d) + 1e-9
    u = np.cross(d, (0, 0, 1) if abs(d[2]) < 0.9 else (1, 0, 0))
    u /= np.linalg.norm(u)
    w = np.cross(d, u)
    t = np.linspace(0, 2 * np.pi, seg, endpoint=False)
    ring = np.outer(np.cos(t), u) + np.outer(np.sin(t), w)
    V = np.vstack((a + ring * r, b + ring * (r if r2 is None else r2)))
    F = [(i, (i + 1) % seg, seg + (i + 1) % seg, seg + i) for i in range(seg)]
    S = [True] * seg
    if cap:
        F += [tuple(range(seg - 1, -1, -1)), tuple(range(seg, 2 * seg))]
        S += [False, False]
    G.add(mat, V, F, S)


def sphere(mat, c, r, seg=14, rings=9, sc=(1, 1, 1), rz=0.0, rx=0.0):
    V, F = [], []
    for j in range(rings + 1):
        p = math.pi * j / rings
        for i in range(seg):
            t = 2 * math.pi * i / seg
            V.append((math.sin(p) * math.cos(t) * sc[0], math.sin(p) * math.sin(t) * sc[1], math.cos(p) * sc[2]))
    for j in range(rings):
        for i in range(seg):
            a, b = j * seg + i, j * seg + (i + 1) % seg
            F.append((a, a + seg, b + seg, b))
    G.add(mat, np.array(V) * r @ _rot(rz, rx).T + np.asarray(c), F, [True] * len(F))


def lathe(mat, c, prof, seg=28, rx=0.0, rz=0.0):
    V, F = [], []
    for r, z in prof:
        for i in range(seg):
            t = 2 * math.pi * i / seg
            V.append((r * math.cos(t), r * math.sin(t), z))
    for j in range(len(prof) - 1):
        for i in range(seg):
            a, b = j * seg + i, j * seg + (i + 1) % seg
            F.append((a, b, b + seg, a + seg))
    G.add(mat, np.array(V) @ _rot(rz, rx).T + np.asarray(c), F, [True] * len(F))


def mesh_obj(name, V, F, mat, smooth=True, uv=None):
    me = bpy.data.meshes.new(name)
    me.from_pydata(V.tolist() if hasattr(V, "tolist") else V, [], F)
    if smooth:
        me.polygons.foreach_set("use_smooth", [True] * len(me.polygons))
    me.update()
    me.materials.append(MATS[mat])
    o = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(o)
    return o


def loft(mat, P, closed=False, uv=None, smooth=True):
    """P has shape (rows, cols, 3). Quads run between neighbouring rows."""
    nv, nu = P.shape[:2]
    V = P.reshape(-1, 3)
    mu = nu if closed else nu - 1
    F = []
    for j in range(nv - 1):
        jn = j * nu
        for i in range(mu):
            b = (i + 1) % nu
            F.append((jn + i, jn + b, jn + nu + b, jn + nu + i))
    G.add(mat, V, F, [smooth] * len(F), uv=None if uv is None else uv.reshape(-1, 2))


def polar(mat, cx, cy, shape, prof, nu=160, pu=None, pv=None, th0=PI / 2, th1=None, smooth=True, planar=None):
    """Sweep a (radius, z) profile around a soft outline. The seam sits at the back, away from the camera."""
    th1 = th0 + TAU if th1 is None else th1
    th = np.linspace(th0, th1, nu + 1)
    sh = shape(th) if callable(shape) else np.ones_like(th)
    c, s = np.cos(th), np.sin(th)
    P = np.array([np.stack((cx + r * sh * c, cy + r * sh * s, np.full(nu + 1, z)), 1) for r, z in prof])
    uv = None
    if planar:
        uv = np.stack((P[:, :, 0] / planar, P[:, :, 1] / planar), 2)
    elif pu:
        ref = P[int(np.argmax([r for r, _ in prof]))]
        ds = np.concatenate(([0.0], np.cumsum(np.linalg.norm(np.diff(ref, axis=0), axis=1))))
        n = max(1, round(ds[-1] / pu))
        u = ds / ds[-1] * n
        uv = np.zeros((len(prof), nu + 1, 2))
        uv[:, :, 0] = u
        if pv:
            lens = [0.0]
            for (r0, z0), (r1, z1) in zip(prof, prof[1:]):
                lens.append(lens[-1] + math.hypot(r1 - r0, z1 - z0))
            for j, l_ in enumerate(lens):
                uv[j, :, 1] = l_ / pv
    loft(mat, P, uv=uv, smooth=smooth)


def fill(mat, cx, cy, shape, r, z, nu=120, planar=0.42):
    polar(mat, cx, cy, shape, [(x, z) for x in (r, r * 0.66, r * 0.33, r * 0.015)], nu=nu, planar=planar, smooth=False)


def blob(a=0.04, b=0.025, p1=0.0, p2=0.0, c=0.0, p3=0.0):
    def f(th):
        return 1 + a * np.sin(2 * th + p1) + b * np.sin(3 * th + p2) + c * np.sin(5 * th + p3)
    return f


def tube(mat, pts, r0, r1=None, seg=8, flat=1.0):
    pts = np.asarray(pts, float)
    n = len(pts)
    r1 = r0 if r1 is None else r1
    t = np.gradient(pts, axis=0)
    t /= np.linalg.norm(t, axis=1, keepdims=True) + 1e-9
    a = np.linspace(0, TAU, seg, endpoint=False)
    rows = []
    for i in range(n):
        ref = (0, 0, 1) if abs(t[i, 2]) < 0.92 else (1, 0, 0)
        u = np.cross(t[i], ref)
        u /= np.linalg.norm(u)
        w = np.cross(t[i], u)
        r = r0 + (r1 - r0) * i / (n - 1)
        rows.append(pts[i] + np.outer(np.cos(a), u) * r * flat + np.outer(np.sin(a), w) * r)
    rows = np.array(rows)
    F = []
    for j in range(n - 1):
        for i in range(seg):
            b = (i + 1) % seg
            F.append((j * seg + i, j * seg + b, (j + 1) * seg + b, (j + 1) * seg + i))
    G.add(mat, rows.reshape(-1, 3), F, [True] * len(F))


def torus(mat, c, R, r, n=120, sides=8, rx=0.0, ry=0.0, rz=0.0):
    t = np.linspace(0, TAU, n, endpoint=False)
    s = np.linspace(0, TAU, sides, endpoint=False)
    V = []
    for a in t:
        for b in s:
            q = R + r * math.cos(b)
            V.append((q * math.cos(a), q * math.sin(a), r * math.sin(b)))
    F = []
    for i in range(n):
        for j in range(sides):
            i2, j2 = (i + 1) % n, (j + 1) % sides
            F.append((i * sides + j, i2 * sides + j, i2 * sides + j2, i * sides + j2))
    G.add(mat, np.array(V) @ _rot(rz, rx, ry).T + np.asarray(c), F, [True] * len(F))


def panels(mat, f, nu, nv, sub=2, gap=0.02, jitter=0.4, back="seamdark", inset=0.012, stagger=False, seed=0, u0=0.0, u1=1.0, v0=0.0, v1=1.0):
    """A skin of separate mirror panels, each tilted slightly so the reflection breaks like real stainless."""
    rng = np.random.default_rng(seed)
    n = sub + 1
    ls = gap / 2 + (1 - gap) * np.linspace(0, 1, n)
    LU, LV = np.meshgrid(ls, ls, indexing="xy")
    iu, iv = np.meshgrid(np.arange(nu), np.arange(nv), indexing="xy")
    iu, iv = iu.ravel()[:, None, None], iv.ravel()[:, None, None]
    U = (iu + LU[None]) / nu
    if stagger:
        U = U + (iv % 2) * 0.5 / nu
    U = u0 + (u1 - u0) * U
    W = v0 + (v1 - v0) * (iv + LV[None]) / nv
    P = f(U.ravel(), W.ravel(), 0.0).reshape(-1, n * n, 3)
    c_ = P.mean(axis=1, keepdims=True)
    w = rng.normal(size=(len(P), 1, 3)) * math.radians(jitter)
    P = c_ + (P - c_) + np.cross(w, P - c_)
    V = P.reshape(-1, 3)
    uv = np.zeros((len(V), 2))
    uv[:, 0] = np.repeat(rng.random(len(P)) ** 2, n * n)
    F = []
    for k in range(len(P)):
        b = k * n * n
        for j in range(sub):
            for i in range(sub):
                a0 = b + j * n + i
                F.append((a0, a0 + 1, a0 + n + 1, a0 + n))
    G.add(mat, V, F, [True] * len(F), uv=uv)
    if back:
        bu = np.linspace(u0, u1, nu * 2 + 1)
        bw = np.linspace(v0, v1, nv * 2 + 1)
        BU, BW = np.meshgrid(bu, bw, indexing="xy")
        BP = f(BU.ravel(), BW.ravel(), -inset).reshape(len(bw), len(bu), 3)
        loft(back, BP)


def sweep(mat, pts, section, closed=False, smooth=True, open_section=False):
    """Carry a (side, up) section along a path. Up stays world Z, like a level guideway."""
    pts = np.asarray(pts, float)
    d = np.roll(pts, -1, axis=0) - np.roll(pts, 1, axis=0)
    if not closed:
        d[0], d[-1] = pts[1] - pts[0], pts[-1] - pts[-2]
    n_ = np.stack((-d[:, 1], d[:, 0], np.zeros(len(d))), axis=1)
    n_ /= np.linalg.norm(n_, axis=1, keepdims=True) + 1e-9
    sec = list(section) + ([] if open_section else [section[0]])
    rows = np.array([pts + n_ * s + np.array((0, 0, z)) for s, z in sec])
    loft(mat, rows, closed=closed, smooth=smooth)


def rr_section(w, h, k=0.3):
    a, b = w / 2, h / 2
    r = min(a, b) * k * 2
    out = []
    for cx, cy, a0 in ((a - r, b - r, 0), (-a + r, b - r, 90), (-a + r, -b + r, 180), (a - r, -b + r, 270)):
        for t in (0, 45, 90):
            q = math.radians(a0 + t)
            out.append((cx + r * math.cos(q), cy + r * math.sin(q)))
    return out


# ---------- small living things ----------
def cypress(x, y, z, h=1.0, seed=None):
    r = h * 0.13
    prof = [(0, 0)]
    for t in np.linspace(0.04, 1.0, 12):
        prof.append((r * (math.sin(PI * t ** 0.62)) ** 0.8 + 0.002, h * t))
    # Its own object with its origin at the foot, so the motion pass can pin the foot and let the tip sway on its own beat.
    seg = 10
    V = [(a * math.cos(TAU * i / seg), a * math.sin(TAU * i / seg), b) for a, b in prof for i in range(seg)]
    F = [(j * seg + i, j * seg + (i + 1) % seg, (j + 1) * seg + (i + 1) % seg, (j + 1) * seg + i) for j in range(len(prof) - 1) for i in range(seg)]
    mesh_obj("cypress", V, F, "cypress").location = (x, y, z)


def topiary(x, y, z, r=0.13, stem=0.0):
    if stem:
        cyl("trunk", (x, y, z), (x, y, z + stem), r * 0.12, seg=5, cap=False)
    sphere("hedge", (x, y, z + stem + r * 0.92), r, seg=12, rings=8)


def planter(x, y, z, r=0.16, h=0.1, plant="cypress", ph=0.75):
    lathe("trencadis", (x, y, z), [(r * 0.72, 0), (r, h * 0.8), (r, h), (r * 0.8, h), (r * 0.8, h * 0.72)], seg=20)
    lathe("soil", (x, y, z + h * 0.72), [(r * 0.8, 0), (0.001, 0)], seg=14)
    if plant == "cypress":
        cypress(x, y, z + h * 0.7, ph)
    elif plant == "ball":
        topiary(x, y, z + h * 0.7, ph * 0.3)


def lamp_post(x, y, z, h=0.22):
    cyl("rail", (x, y, z), (x, y, z + h), 0.006, seg=5, cap=False)
    sphere("lamp", (x, y, z + h + 0.012), 0.015, seg=8, rings=5)


def bench(x, y, z, rz=0.0):
    box("white2", (x, y, z + 0.03), (0.28, 0.08, 0.06), r=0.012, rz=rz)
    box("wood", (x, y, z + 0.065), (0.27, 0.075, 0.012), r=0.003, rz=rz)


def skylight(x, y, z, r=0.13):
    lathe("white2", (x, y, z), [(r + 0.025, 0), (r + 0.025, 0.018), (r, 0.022), (r, 0.012)], seg=20)
    lathe("chrome2", (x, y, z + 0.012), [(r, 0), (r * 0.6, 0.012), (0.001, 0.018)], seg=20)


def stairs(x, y, z_top, z_bot, rz, w=0.72, n=7, tread=0.13, mat="white2"):
    dx, dy = math.cos(rz), math.sin(rz)
    rise = (z_top - z_bot) / n
    for i in range(n):
        q = i + 0.5
        zt = z_top - rise * (i + 1)
        box(mat, (x + dx * tread * q, y + dy * tread * q, (zt + z_bot) / 2), (tread + 0.002, w, max(zt - z_bot, 0.01)), r=0.003, rz=rz, seg=1)
    L = math.hypot(tread * n, z_top - z_bot)
    slope = math.atan2(z_top - z_bot, tread * n)
    midx, midy = x + dx * tread * n / 2, y + dy * tread * n / 2
    px, py = -dy, dx
    for s in (-1, 1):
        box("white2", (midx + px * s * (w / 2 + 0.03), midy + py * s * (w / 2 + 0.03), (z_top + z_bot) / 2 + 0.03), (L + 0.04, 0.06, 0.09), r=0.012, rz=rz, ry=slope)


# ---------- the bots: the body shapes from the brand art ----------
def bot(c, s, shape="squircle", facing=math.radians(18), prop=None, side=None, scale=1.0, lift=0.0):
    base = (c[0], c[1], c[2] - 0.47 * s)
    m = mascots.placed_mesh(shape, size=s, base=base, facing=facing, pitch=math.radians(-7))
    G.add("bot", m["body_v"], m["body_f"], [True] * len(m["body_f"]))
    G.add("eye", m["eye_v"], m["eye_f"], [True] * len(m["eye_f"]))
    if prop:
        for part in mascots.placed_prop(prop, shape=shape, size=s, base=base, facing=facing, pitch=math.radians(-7), side=side, scale=scale, lift=lift):
            G.add(part["mat"], part["v"], part["f"], [True] * len(part["f"]))


def sat(col):
    m_ = max(col)
    return tuple((x / m_) ** 1.45 for x in col)


def bot_mats(key, col, state):
    c_ = sat(col)
    hot = tuple(x * 0.92 + 0.08 for x in c_)
    k = dict(idle=0.62, working=1.0, found=1.3, done=0.85, main=1.0)[state]
    names = dict(led_on=f"led_on_{key}", led_dim=f"led_dim_{key}", led_hot=f"led_hot_{key}", bot=f"bot_{key}")
    MATS[names["led_on"]] = pbsdf(names["led_on"], c_, 0.3, emis=c_, emis_str=0.72 * k)
    MATS[names["led_dim"]] = pbsdf(names["led_dim"], c_, 0.3, emis=c_, emis_str=1.8 * k)
    MATS[names["led_hot"]] = pbsdf(names["led_hot"], c_, 0.3, emis=hot, emis_str=4.6 * k)
    MATS[names["bot"]] = pbsdf(names["bot"], col, mascots.GLOSSY["roughness"], coat=mascots.GLOSSY["coat"], coat_rough=mascots.GLOSSY["coat_roughness"], sss=mascots.GLOSSY["sss"], sss_scale=mascots.GLOSSY["sss_scale"] * 1.05)
    return names, c_


def point(q, col, e, r=0.08):
    l = bpy.data.lights.new("pt", "POINT")
    l.energy = e
    l.color = col
    l.shadow_soft_size = r
    o = bpy.data.objects.new("pt", l)
    o.visible_glossy = False
    o.location = q
    bpy.context.collection.objects.link(o)
    return o


# ---------- terraces ----------
def band(cx, cy, shape, r, z0, z1, glass="glazing", nose="white2", pu=0.55, rec=0.11, bulge=0.03, win=0.36, r_top=None, nu=180):
    """One Galaxy-SOHO style ribbon: a shadow gap of glass with a rounded white nose over it."""
    h = z1 - z0
    g = h * win
    rt = r if r_top is None else r_top
    rm = (r + rt) / 2
    polar(glass, cx, cy, shape, [(r - rec, z0), (r - rec, z0 + g)], nu=nu, pu=0.13, smooth=False)
    b = h - g
    prof = [
        (r - rec, z0 + g),
        (r - 0.035, z0 + g),
        (r + bulge * 0.55, z0 + g + b * 0.12),
        (rm + bulge, z0 + g + b * 0.5),
        (rt + bulge * 0.55, z0 + g + b * 0.88),
        (rt - 0.035, z1),
        (rt - rec, z1),
    ]
    polar(nose, cx, cy, shape, prof, nu=nu, pu=pu)


def plinth(cfg):
    """Two sculpted tiers on the water: a front apron for the bot, a high deck for the building."""
    rnd = random.Random(cfg["seed"])
    P = cfg.get("plinth", {})
    R0, R1 = P.get("R0", 3.35), P.get("R1", 2.0)
    ZL, ZH = P.get("ZL", 0.62), P.get("ZH", 1.34)
    side = cfg.get("side", 1)
    UX, UY = P.get("UX", 0.12 * side), P.get("UY", 1.15)
    sh0 = blob(rnd.uniform(0.02, 0.05), rnd.uniform(0.012, 0.03), rnd.uniform(0, 6), rnd.uniform(0, 6), 0.006, rnd.uniform(0, 6))
    sh1 = blob(rnd.uniform(0.025, 0.06), rnd.uniform(0.012, 0.03), rnd.uniform(0, 6), rnd.uniform(0, 6))
    polar("white", 0, 0, sh0, [(R0 + 0.3, -0.08), (R0 + 0.28, 0.035), (R0 + 0.22, 0.07), (R0 - 0.1, 0.08)], nu=220, pu=0.85)
    nb = P.get("nb", 3)
    for k in range(nb):
        z0 = 0.075 + (ZL - 0.075) * k / nb
        z1 = 0.075 + (ZL - 0.075) * (k + 1) / nb
        band(0, 0, sh0, R0 - 0.02 * k, z0, z1, nu=220, pu=0.62)
    polar("white2", 0, 0, sh0, [(R0 - 0.2, ZL), (R0 + 0.05, ZL), (R0 + 0.075, ZL + 0.025), (R0 + 0.05, ZL + 0.05), (R0 - 0.08, ZL + 0.052), (R0 - 0.1, ZL + 0.02)], nu=220, pu=0.62)
    fill("deck", 0, 0, sh0, R0 - 0.09, ZL + 0.018, nu=160)
    polar("seamdark", 0, 0, sh0, [(R0 - 0.215, ZL + 0.021), (R0 - 0.18, ZL + 0.021)], nu=220, smooth=False)
    # high deck
    nu_ = P.get("nu", 2)
    for k in range(nu_):
        z0 = ZL + (ZH - ZL) * k / nu_
        z1 = ZL + (ZH - ZL) * (k + 1) / nu_
        band(UX, UY, sh1, R1 + 0.03 * (nu_ - 1 - k), z0, z1, nu=180, pu=0.5, win=0.42)
    polar("white2", UX, UY, sh1, [(R1 - 0.2, ZH), (R1 + 0.05, ZH), (R1 + 0.07, ZH + 0.022), (R1 + 0.05, ZH + 0.045), (R1 - 0.07, ZH + 0.046), (R1 - 0.09, ZH + 0.02)], nu=180, pu=0.5)
    fill("deck", UX, UY, sh1, R1 - 0.08, ZH + 0.016, nu=120)
    polar("seamdark", UX, UY, sh1, [(R1 - 0.18, ZH + 0.019), (R1 - 0.15, ZH + 0.019)], nu=180, smooth=False)
    # steel rail on the high deck
    th = np.linspace(0, TAU, 150)
    q = sh1(th)
    rail = np.stack((UX + (R1 + 0.0) * q * np.cos(th), UY + (R1 + 0.0) * q * np.sin(th), np.full(150, ZH + 0.14)), 1)
    tube("rail", rail, 0.0055, seg=5)
    for t_ in np.linspace(0, TAU, 56, endpoint=False):
        q_ = float(sh1(np.array([t_]))[0])
        x_, y_ = UX + R1 * q_ * math.cos(t_), UY + R1 * q_ * math.sin(t_)
        cyl("rail", (x_, y_, ZH + 0.04), (x_, y_, ZH + 0.14), 0.0035, seg=4, cap=False)
    return dict(R0=R0, R1=R1, ZL=ZL + 0.018, ZH=ZH + 0.016, UX=UX, UY=UY, sh0=sh0, sh1=sh1, side=side)


def stage(x, y, z, r, shell_h=0.82):
    """The bot's own stage: a white collar, a polished black disc, its ring of light, and a dark shell behind it."""
    lathe("white2", (x, y, z), [(r + 0.15, 0), (r + 0.15, 0.03), (r + 0.11, 0.055), (r + 0.02, 0.06), (0.001, 0.06)], seg=96)
    lathe("graphite", (x, y, z + 0.05), [(r, 0), (r, 0.04), (r - 0.025, 0.06), (0.001, 0.06)], seg=96)
    torus("led_on", (x, y, z + 0.112), r - 0.09, 0.02, n=96, sides=8)
    for k in range(14):
        a = TAU * k / 14
        sphere("lamp", (x + (r + 0.075) * math.cos(a), y + (r + 0.075) * math.sin(a), z + 0.06), 0.016, seg=8, rings=5)
    # the shell, a tall crescent behind the bot, black inside and white out
    th = np.linspace(math.radians(12), math.radians(168), 72)
    ht = shell_h * np.sin((th - th[0]) / (th[-1] - th[0]) * PI) ** 0.55
    rows = []
    rows2 = []
    for f, off in ((0.0, r + 0.02), (0.92, r + 0.065), (1.0, r + 0.11)):
        rows.append(np.stack((x + off * np.cos(th), y + off * np.sin(th), z + 0.04 + ht * f), 1))
    for f, off in ((1.0, r + 0.11), (0.97, r + 0.17), (0.0, r + 0.2)):
        rows2.append(np.stack((x + off * np.cos(th), y + off * np.sin(th), z + 0.04 + ht * f), 1))
    loft("graphite", np.array(rows))
    loft("white2", np.array(rows2))
    edge = np.stack((x + (r + 0.11) * np.cos(th), y + (r + 0.11) * np.sin(th), z + 0.044 + ht), 1)
    tube("led_on", edge, 0.011, seg=6)


# ---------- the team: colours and shapes are config ----------
BOTS = dict(
    foundry=dict(key="orange", color=(1.0, 0.2, 0.012), shape="squircle", state="working", size=1.02),
    polish=dict(key="pink", color=(1.0, 0.025, 0.24), shape="star", state="working", size=1.2),
    lead=dict(key="lead", color=(0.92, 0.93, 0.95), shape="sphere", state="main", size=1.36),
)
for _b in BOTS.values():
    _b["names"], _b["c"] = bot_mats(_b["key"], _b["color"], _b["state"])
MATS.update(
    hot=pbsdf("hot", (0.06, 0.012, 0.0), 0.4, emis=(1.0, 0.2, 0.012), emis_str=2.0),
    warm2=pbsdf("warm2", (0.1, 0.03, 0.02), 0.35, metal=0.6, emis=(0.75, 0.05, 0.008), emis_str=0.42),
    dull=mat_chrome("dull", (0.62, 0.63, 0.65), 0.34, 0.08),
    ok=pbsdf("ok", (0, 0, 0), 0.3, emis=(0.1, 1.0, 0.3), emis_str=4.0),
    glint=pbsdf("glint", (0, 0, 0), 0.3, emis=(1.0, 0.95, 0.85), emis_str=9.0),
    lens=pbsdf("lens", (0.6, 0.85, 1.0), 0.03, coat=1.0),
)
MATS.update(mascots.prop_materials(pbsdf, size=0.82))
G = Geo()
CUR = {}
CAM_XY = (-8.6, -39.4)


def use(b):
    global CUR
    CUR = BOTS[b]["names"] if b else {}


def rotated(angle, cx, cy, fn):
    """Run a builder, then turn everything it added about a vertical axis."""
    mark = {k: len(e["v"]) for k, e in G.d.items()}
    fn()
    c, s = math.cos(angle), math.sin(angle)
    for k, e in G.d.items():
        for i in range(mark.get(k, 0), len(e["v"])):
            V = e["v"][i].copy()
            x, y = V[:, 0] - cx, V[:, 1] - cy
            V[:, 0], V[:, 1] = cx + c * x - s * y, cy + s * x + c * y
            e["v"][i] = V


def plate(c, w=1.0, h=0.72, rz=0.0, rx=0.0, ry=0.0, mat="chrome", sag=None):
    """One polished panel, curved like the ring it is made for: mirror on both faces, a thin steel edge. Local X is width, Z height."""
    c = np.asarray(c, float)
    R = _rot(rz, rx, ry)
    sag = 0.11 * w if sag is None else sag
    U, Vv = np.meshgrid(np.linspace(-1, 1, 15), np.linspace(-1, 1, 4), indexing="xy")

    def sheet(off):
        return np.stack((U * w / 2, sag * (1 - U * U) + off, Vv * h / 2), 2) @ R.T + c

    loft(mat, sheet(-0.012))
    loft(mat, sheet(0.012))
    e = np.linspace(-1, 1, 13)
    per = [(x, sag * (1 - x * x), -1.0) for x in e] + [(x, sag * (1 - x * x), 1.0) for x in e[::-1]]
    per.append(per[0])
    tube("steel", (np.array([(p[0] * w / 2, p[1], p[2] * h / 2) for p in per]) @ R.T + c), 0.017, seg=5)


def rack(c, rz, n, w=1.0, h=0.72, mat="chrome", tilt=-0.26, gap=0.24, lit=None, live=None):
    """Panels standing in a rack. This is how output piles up along the line."""
    c = np.asarray(c, float)
    cz, sz = math.cos(rz), math.sin(rz)
    depth = gap * n + 0.3
    box("white2", c + (0, 0, 0.035), (w + 0.26, depth, 0.07), r=0.02, rz=rz)
    for s_ in (-1, 1):
        p = c + np.array((cz * s_ * (w / 2 + 0.07), sz * s_ * (w / 2 + 0.07), 0.0))
        box("steel", p + (0, 0, 0.09), (0.04, depth * 0.92, 0.05), r=0.008, rz=rz)
    for i in range(n):
        q = (i - (n - 1) / 2) * gap
        p = c + np.array((-sz * q, cz * q, h / 2 + 0.08))
        if live:
            PT.spot(live, p, scale=w, yaw=rz)
        with PT.drop() if live else nullcontext():
            plate(p, w, h, rz=rz, rx=tilt, mat=mat, sag=0.045)
            if lit:
                sphere(lit, p + np.array((cz * (w / 2 + 0.04), sz * (w / 2 + 0.04), h / 2 + 0.05)), 0.024, seg=8, rings=5)


def glint(c, r=0.12):
    """A few sparks where the work is touching metal."""
    c = np.asarray(c, float)
    rn = random.Random(int(abs(c[0]) * 100))
    sphere("hot", c, 0.02, seg=8, rings=5)
    for _ in range(9):
        d = np.array((rn.uniform(-1, 1), rn.uniform(-1, 0.2), rn.uniform(-1.2, 0.5)))
        sphere("hot", c + d * r * rn.uniform(0.4, 1.3), rn.uniform(0.005, 0.011), seg=6, rings=4)


# ---------- the citadel: one spiral ramp climbing a white hill ----------
HX, HY = 2.6, 0.0
TH0 = math.radians(190)
TURNS = 2.5
THE = TH0 + TURNS * TAU
R0_, R1_ = 9.2, 4.6
Z0_, Z1_ = 0.42, 5.6
W_ = (R0_ - R1_) / TURNS


def Rf(th):
    return R0_ + (R1_ - R0_) * (th - TH0) / (THE - TH0)


def Zf(th):
    return Z0_ + (Z1_ - Z0_) * (th - TH0) / (THE - TH0)


def pt(th, dr=0.0, dz=0.0):
    r = Rf(th) + dr
    return np.array((HX + r * math.cos(th), HY + r * math.sin(th), Zf(th) + dz))


def sp(mat, rows, th, pu=None, pv=None, smooth=True, planar=None):
    """Loft along the spiral. rows is a list of (radial offset from the outer edge, absolute z array or z offset from the ramp)."""
    R, Z = Rf(th), Zf(th)
    c, s = np.cos(th), np.sin(th)
    P = []
    for dr, z in rows:
        zz = z if isinstance(z, np.ndarray) else Z + z
        P.append(np.stack((HX + (R + dr) * c, HY + (R + dr) * s, zz), 1))
    P = np.array(P)
    uv = None
    if planar:
        uv = np.stack((P[:, :, 0] / planar, P[:, :, 1] / planar), 2)
    elif pu:
        ds = np.concatenate(([0.0], np.cumsum(np.linalg.norm(np.diff(P[0], axis=0), axis=1))))
        uv = np.zeros((len(rows), len(th), 2))
        uv[:, :, 0] = ds / pu
        if pv:
            d2 = np.concatenate((np.zeros((1, len(th))), np.cumsum(np.linalg.norm(np.diff(P, axis=0), axis=2), axis=0)))
            uv[:, :, 1] = d2 / pv
    loft(mat, P, uv=uv, smooth=smooth)


def build_hill():
    n = 1100
    th = np.linspace(TH0, THE, n)
    Z = Zf(th)
    # walls under the ramp's outer edge: ribbons of glass, down to the turn below or to the water
    base = np.where(th - TAU >= TH0, Zf(th - TAU) - 0.02, -0.12)
    top = Z - 0.3
    nb = 2
    for k in range(nb):
        fa, fb = k / nb, (k + 1) / nb
        za, zb = base + (top - base) * fa, base + (top - base) * fb
        zg = za + (zb - za) * 0.3
        sp("glazing", [(-0.13, za), (-0.13, zg)], th, pu=0.2, smooth=False)
        rows = [(-0.13, zg), (-0.05, zg), (0.01, zg + (zb - zg) * 0.1), (0.035, zg + (zb - zg) * 0.5), (0.01, zg + (zb - zg) * 0.9), (-0.05, zb), (-0.13, zb)]
        sp("white2", rows, th, pu=2.6)
    # foot in the water
    th1 = th[th - TAU < TH0]
    sp("white", [(0.34, np.full(len(th1), -0.1)), (0.32, np.full(len(th1), 0.05)), (0.24, np.full(len(th1), 0.09)), (-0.05, np.full(len(th1), 0.1))], th1, pu=0.9)
    # rounded lip, then the ramp floor
    sp("white2", [(-0.1, -0.31), (0.05, -0.3), (0.085, -0.2), (0.085, 0.03), (0.05, 0.1), (-0.09, 0.11), (-0.13, 0.015)], th, pu=2.6)
    sp("deck", [(-0.1, 0.012), (-W_ - 0.02, 0.012)], th, pu=0.7, pv=0.7, smooth=False)
    sp("seamdark", [(-W_ + 0.2, 0.016), (-W_ + 0.16, 0.016)], th, smooth=False)
    # steel rail on the lip
    pts = np.array([pt(t, -0.02, 0.36) for t in th[::4]])
    tube("rail", pts, 0.009, seg=5)
    # a ribbon of mirror under every lip, so each turn draws one bright line of sky
    sp("chrome", [(0.09, -0.2), (0.094, -0.12), (0.09, -0.04)], th)
    # pilasters at an even walking distance. They throw long shadows, and their mirror blades flash where the curve meets the sun.
    t_ = TH0 + 0.12
    while t_ < THE - 0.05:
        z0_ = float(Zf(t_ - TAU)) - 0.02 if t_ - TAU >= TH0 else -0.1
        z1_ = float(Zf(t_)) - 0.22
        if z1_ - z0_ > 0.5:
            c0, s0 = math.cos(t_), math.sin(t_)
            r0 = float(Rf(t_))
            box("white2", (HX + (r0 + 0.02) * c0, HY + (r0 + 0.02) * s0, (z0_ + z1_) / 2), (0.2, 0.14, z1_ - z0_), r=0.03, rz=t_)
            box("chrome", (HX + (r0 + 0.122) * c0, HY + (r0 + 0.122) * s0, (z0_ + z1_) / 2), (0.016, 0.055, (z1_ - z0_) * 0.86), r=0.004, rz=t_, seg=1)
        t_ += 2.35 / float(Rf(t_))
    for t in th[::14]:
        cyl("rail", pt(t, -0.02, 0.1), pt(t, -0.02, 0.36), 0.0055, seg=4, cap=False)
    # the summit drum: last turn's inner wall, up to the deck
    th2 = th[th >= THE - TAU]
    zt = np.full(len(th2), Z1_ + 0.04)
    for k in range(2):
        za = Zf(th2) + (zt - Zf(th2)) * k / 2
        zb = Zf(th2) + (zt - Zf(th2)) * (k + 1) / 2
        zg = za + (zb - za) * 0.4
        sp("glazing", [(-W_ + 0.06, za), (-W_ + 0.06, zg)], th2, pu=0.2, smooth=False)
        sp("white2", [(-W_ + 0.06, zg), (-W_ - 0.0, zg + (zb - zg) * 0.2), (-W_ - 0.0, zb), (-W_ + 0.06, zb)], th2, pu=0.8)
        sp("chrome", [(-W_ + 0.012, zb - 0.1), (-W_ + 0.018, zb - 0.06), (-W_ + 0.012, zb - 0.02)], th2)
    # summit deck
    rr = Rf(th2) - W_
    c, s = np.cos(th2), np.sin(th2)
    P = np.array([np.stack((HX + rr * f * c, HY + rr * f * s, np.full(len(th2), Z1_ + 0.04)), 1) for f in (1.0, 0.66, 0.33, 0.01)])
    loft("deck", P, uv=np.stack((P[:, :, 0] / 0.7, P[:, :, 1] / 0.7), 2), smooth=False)
    # living things that follow the climb: a clipped hedge against the wall, and cypress
    for a, b in ((212, 262), (285, 345), (390, 500), (560, 630), (720, 790), (905, 985)):
        tt = np.linspace(math.radians(a), math.radians(b), 90)
        sp("hedge", [(-W_ + 0.36, 0.01), (-W_ + 0.36, 0.14), (-W_ + 0.32, 0.19), (-W_ + 0.08, 0.19), (-W_ + 0.04, 0.14), (-W_ + 0.04, 0.01)], tt)
    for d, h in ((262, 1.35), (272, 1.05), (283, 1.5), (345, 1.2), (356, 1.5), (560, 1.3), (548, 1.05), (632, 1.5), (642, 1.2), (795, 1.3), (985, 1.2), (996, 1.5)):
        t = math.radians(d)
        planter(*pt(t, -W_ + 0.24), r=0.13, h=0.07, ph=h)
    for d in range(215, 1090, 21):
        t = math.radians(d)
        lamp_post(*pt(t, -0.14, 0.11), h=0.2)


GUIDE = -0.66   # the guideway runs along the outer part of the ramp
GZ = 0.27
TERR_TH = math.radians(670)


def guideway():
    n = 900
    segs = (("foundry", TH0 + 0.02, TERR_TH), ("polish", TERR_TH, THE - 0.1))
    w, h = 0.3, 0.08
    for who, a, b in segs:
        use(who)
        th = np.linspace(a, b, int(n * (b - a) / (THE - TH0)))
        pts = np.array([pt(t, GUIDE, GZ) for t in th])
        sweep("white2", pts, rr_section(w, h))
        sweep("led_on", pts, [(-0.05, h / 2 + 0.003), (0.05, h / 2 + 0.003)], smooth=False, open_section=True)
        for s_ in (-1, 1):
            sweep("led_on", pts, [(s_ * (w / 2 + 0.002), -h * 0.3), (s_ * (w / 2 + 0.002), h * 0.3)], smooth=False, open_section=True)
            sweep("steel", pts, [(s_ * 0.105 - 0.014, h / 2 + 0.006), (s_ * 0.105 + 0.014, h / 2 + 0.006)], smooth=False, open_section=True)
        for t in np.arange(a + 0.03, b, 0.2):
            q = pt(t, GUIDE, 0.012)
            lathe("white2", q, [(0.1, 0), (0.08, 0.03), (0.035, 0.08), (0.035, GZ - 0.05)], seg=10)
    use(None)


def pod(th, who, load=2, mat="chrome", ahead=0.0):
    """A maglev pod with panels standing on it. It floats a hand's width over the rail."""
    pod_at(pt(th, GUIDE, GZ + 0.28), th + PI / 2, who, load, mat)


def pod_at(q, head, who, load=2, mat="chrome"):
    use(who)
    q = np.asarray(q, float)
    c, s = math.cos(head), math.sin(head)
    L_, W2, H2 = 1.0, 0.27, 0.2

    def body(sv, av, k=1.0):
        """sv along the pod from -1 to 1, av round its section. Pointed like a maglev nose at both ends."""
        t = (1.0 - np.abs(sv) ** 2.6) ** 0.62
        ca, sa = np.cos(av), np.sin(av)
        y_ = W2 * t * k * np.sign(ca) * np.abs(ca) ** 0.62
        z_ = H2 * t * k * np.sign(sa) * np.abs(sa) ** 0.62 - 0.05 * (1 - t)
        x_ = L_ * sv
        return np.stack((q[0] + c * x_ - s * y_, q[1] + s * x_ + c * y_, q[2] + z_), -1)

    Sv, Av = np.meshgrid(np.linspace(-0.999, 0.999, 41), np.linspace(0, TAU, 25), indexing="xy")
    loft("pod", body(Sv, Av), smooth=True)
    for sd in (0.0, PI):
        sgn = 1 if sd == 0.0 else -1
        for m_, a0, a1, s1 in (("led_on", -0.72, -0.34, 0.93), ("podglass", 0.14, 0.62, 0.78)):
            Sv, Av = np.meshgrid(np.linspace(-s1, s1, 25), np.linspace(a0, a1, 3), indexing="xy")
            Av2 = sd + sgn * Av
            loft(m_, body(Sv, Av2, 1.012), smooth=True)
    box("white2", q + (0, 0, 0.21), (1.06, 0.34, 0.035), r=0.012, rz=head)
    for i in range(load):
        o = (i - (load - 1) / 2) * 0.17
        sgn = -1 if i == 0 else 1
        plate(q + np.array((-s * o, c * o, 0.22 + 0.27)), 0.98, 0.52, rz=head, rx=0.26 * sgn, mat=mat, sag=0.07)
    use(None)


def pod_gate(th, depth=1.8):
    """A small white garage across the rail. Pods come out of one at the bottom and go into one at the top."""
    q = pt(th, GUIDE, 0.0)
    head = th + PI / 2
    c, s = math.cos(head), math.sin(head)
    back = np.array((c, s, 0.0)) * (depth / 2 + 0.03)
    # The lower gate faces down the line, the upper one faces away from the pods' travel.
    sign = -1.0 if th < PI * 2 else 1.0
    box("white2", q + back * sign + (0, 0, 0.7), (depth, 1.42, 1.4), r=0.1, rz=head)
    box("seamdark", q + (0, 0, 0.62), (0.03, 1.02, 1.1), r=0.0, rz=head)
    pts = [q + np.array((-s * 0.62 * math.cos(a), c * 0.62 * math.cos(a), 0.14 + 1.12 * math.sin(a) ** 0.5)) for a in np.linspace(0, PI, 22)]
    tube("chrome", pts, 0.035, seg=7)


def hand_carry(x, y, z, s, rz, mat="chrome", tilt=-0.28):
    """A panel balanced on a bot's head, the way an armless bot carries it."""
    plate((x, y, z + s * 1.0 + 0.4), 1.1, 0.74, rz=rz, rx=tilt, ry=0.06, mat=mat)
    box("white2", (x, y, z + s * 1.0 + 0.015), (0.24, 0.16, 0.03), r=0.01, rz=rz)


def bot_pad(x, y, z, r, who, shell=None):
    """The bot's own pad: polished black with its ring of colour, so it reads on white."""
    use(who)
    if shell:
        stage(x, y, z, r, shell_h=shell)
    else:
        lathe("white2", (x, y, z), [(r + 0.12, 0), (r + 0.12, 0.025), (r + 0.08, 0.05), (r, 0.052), (0.001, 0.052)], seg=72)
        lathe("graphite", (x, y, z + 0.045), [(r, 0), (r, 0.03), (r - 0.02, 0.05), (0.001, 0.05)], seg=72)
        torus("led_on", (x, y, z + 0.098), r - 0.07, 0.022, n=72, sides=8)
    use(None)


def place_bot(who, x, y, z, facing, prop=None, side=None, scale=1.0, lift=0.0):
    use(who)
    s = BOTS[who]["size"]
    if PT.ON:
        PT.bot(who, (x, y, z), s, yaw=facing, shape=BOTS[who]["shape"], tool=prop)
        if prop:
            with PT.actor(f"tool_{who}", pivot=(x, y, z)):
                for part in mascots.placed_prop(prop, shape=BOTS[who]["shape"], size=s, base=(x, y, z), facing=facing, pitch=math.radians(-7), side=side, scale=scale, lift=lift):
                    G.add(part["mat"], part["v"], part["f"], [True] * len(part["f"]))
        use(None)
        return
    bot((x, y, z + s * 0.47), s, BOTS[who]["shape"], facing=facing, prop=prop, side=side, scale=scale, lift=lift)
    use(None)


def face_from(dx, dy):
    """The facing angle that points the eyes along (dx, dy)."""
    return math.atan2(dx, -dy)


def face_toward(x, y, wx, wy, limit=math.radians(38)):
    """Turn toward the work, but never so far from the camera that the eyes are lost."""
    cam = face_from(CAM_XY[0] - x, CAM_XY[1] - y)
    d = (face_from(wx - x, wy - y) - cam + PI) % TAU - PI
    return cam + max(-limit, min(limit, d))


# ---------- station one: the foundry on the pool ----------
QX, QY = -7.0, -6.3


def vault():
    """A long ribbed shed in local X, open at the +X end where the furnace mouth glows."""
    L, Wd, H = 4.4, 2.5, 2.0
    n = 11
    rows = []
    for k in range(n):
        q = k / (n - 1)
        x0 = -L / 2 + L * q
        hh = H * (0.82 + 0.18 * math.sin(PI * q))
        ww = Wd / 2 * (0.92 + 0.08 * math.sin(PI * q))
        lean = 0.14 * (q - 0.5)
        pts = []
        for t in np.linspace(0, 1, 24):
            a = PI * t
            pts.append((QFX + x0 + lean * math.sin(a), QFY - math.cos(a) * ww, QZ + math.sin(a) ** 0.74 * hh))
        tube("white2", pts, 0.06, 0.05, seg=8)
        rows.append(np.array([(p[0], QFY + (p[1] - QFY) * 0.95, QZ + (p[2] - QZ) * 0.95) for p in pts]))
        for j in (0, 23):
            box("white2", (pts[j][0], pts[j][1], QZ + 0.06), (0.22, 0.2, 0.12), r=0.03)
    R = np.array(rows)
    uv = np.zeros((R.shape[0], R.shape[1], 2))
    uv[:, :, 0] = np.arange(R.shape[1])[None, :] * 0.5
    loft("glazing", R, uv=uv)
    # the back wall, dark inside, and the furnace mouth
    box("seamdark", (QFX - L / 2 + 0.3, QFY, QZ + 0.85), (0.06, Wd * 0.9, 1.7), r=0.0)
    box("graphite", (QFX + L / 2 - 0.42, QFY, QZ + 0.86), (0.5, 2.1, 1.7), r=0.04)
    box("hot", (QFX + L / 2 - 0.16, QFY, QZ + 1.0), (0.03, 1.15, 0.5), r=0.0)
    # the crown of the shed carries the line's colour
    use("foundry")
    tube("led_on", [(QFX - L / 2 + L * (k / 12), QFY, QZ + H * (0.82 + 0.18 * math.sin(PI * k / 12)) + 0.075) for k in range(13)], 0.024, seg=6)
    use(None)


def build_foundry():
    global QFX, QFY, QZ
    QZ = 0.46
    sh = blob(0.09, 0.05, 0.6, 1.8, 0.012, 0.0)
    R = 4.1
    polar("white", QX, QY, sh, [(R + 0.32, -0.1), (R + 0.3, 0.04), (R + 0.22, 0.08), (R - 0.1, 0.09)], nu=240, pu=0.9)
    for k in range(2):
        z0, z1 = 0.08 + (QZ - 0.08) * k / 2, 0.08 + (QZ - 0.08) * (k + 1) / 2
        band(QX, QY, sh, R, z0, z1, nu=240, pu=0.7, rec=0.09, bulge=0.025, win=0.34)
    polar("white2", QX, QY, sh, [(R - 0.14, QZ), (R + 0.05, QZ), (R + 0.075, QZ + 0.03), (R + 0.05, QZ + 0.06), (R - 0.08, QZ + 0.065), (R - 0.1, QZ + 0.02)], nu=240, pu=0.7)
    fill("deck", QX, QY, sh, R - 0.08, QZ + 0.02, nu=160, planar=0.7)
    polar("seamdark", QX, QY, sh, [(R - 0.2, QZ + 0.024), (R - 0.165, QZ + 0.024)], nu=240, smooth=False)
    QZ = QZ + 0.02
    # the shed, its long axis pointing at the loading bay
    QFX, QFY = -9.0, -4.0
    ang = math.radians(-24)
    rotated(ang, QFX, QFY, vault)
    u = np.array((math.cos(ang), math.sin(ang)))
    v = np.array((-u[1], u[0]))
    # the rolling line from the furnace mouth to the bay
    a = np.array((QFX, QFY)) + u * 2.05
    Ln = 3.95
    LZ = 1.02
    for s_ in (-1, 1):
        p0 = a + v * s_ * 0.3
        p1 = p0 + u * Ln
        box("white2", ((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, QZ + LZ), (Ln, 0.07, 0.1), r=0.02, rz=ang)
    for k in range(int(Ln / 0.2)):
        c_ = a + u * (0.1 + k * 0.2)
        cyl("steel", (*(c_ + v * 0.27), QZ + LZ + 0.05), (*(c_ - v * 0.27), QZ + LZ + 0.05), 0.026, seg=8)
    for f in (0.3, 1.3, 2.3, 3.3):
        c_ = a + u * f
        box("steel", (c_[0], c_[1], QZ + LZ / 2), (0.08, 0.5, LZ), r=0.012, rz=ang)
    # one panel changing from hot metal to mirror as it travels
    with PT.drop():
        for f, m_ in ((0.62, "hot"), (1.7, "warm2"), (2.78, "dull")):
            c_ = a + u * f
            plate((c_[0], c_[1], QZ + LZ + 0.42), 0.9, 0.62, rz=ang, rx=-0.3, mat=m_, sag=0.04)
    # the burnishing hood, where dull metal comes out bright
    c_ = a + u * 2.62
    for s_ in (-1, 1):
        p_ = c_ + v * s_ * 0.44
        lathe("white2", (p_[0], p_[1], QZ), [(0.1, 0), (0.08, 0.06), (0.05, 0.14), (0.045, LZ + 1.02)], seg=12)
    box("white2", (c_[0], c_[1], QZ + LZ + 1.02), (0.3, 1.06, 0.14), r=0.04, rz=ang)
    use("foundry")
    box("led_hot", (c_[0], c_[1], QZ + LZ + 0.94), (0.035, 0.7, 0.012), r=0.0, rz=ang)
    use(None)
    PT.path("line", [(*(a + u * 0.25), QZ + LZ + 0.42), (*(a + u * 3.8), QZ + LZ + 0.42)])
    PT.spot("line_panel", (*(a + u * 0.25), QZ + LZ + 0.42), scale=0.9, yaw=ang)
    PT.spot("melt_a", (*(a - u * 0.05), QZ + LZ + 0.085))
    PT.spot("melt_b", (*(a + u * 1.3), QZ + LZ + 0.085))
    PT.spot("melt_side", (*(a - u * 0.05 + v * 0.25), QZ + LZ + 0.085))
    PT.spot("hood", (c_[0], c_[1], QZ + LZ + 0.5))
    # two stacks behind the shed: the only verticals on this side, and hot at the lip
    for sx_, sy_, top_ in ((-10.75, -2.55, 5.4), (-9.55, -1.95, 4.3)):
        lathe("white2", (sx_, sy_, 0.0), [(0.5, 0), (0.44, 0.3), (0.32, top_ * 0.55), (0.25, top_ - 0.04), (0.285, top_), (0.2, top_ + 0.03), (0.001, top_ - 0.3)], seg=30)
        cyl("chrome", (sx_, sy_, top_ - 0.85), (sx_, sy_, top_ - 0.6), 0.285, seg=30)
        cyl("chrome", (sx_, sy_, top_ - 0.42), (sx_, sy_, top_ - 0.34), 0.272, seg=30)
        torus("hot", (sx_, sy_, top_ + 0.012), 0.205, 0.03, n=40, sides=6)
        PT.spot("stack", (sx_, sy_, top_ + 0.1))
    point((a[0] + u[0] * 0.55 - v[0] * 0.9, a[1] + u[1] * 0.55 - v[1] * 0.9, QZ + 1.5), (1.0, 0.33, 0.06), 16.0, r=0.4)
    # raw stock: dull sheet stacked on pallets at the back of the shed
    _rs = random.Random(4)
    for (cx, cy, n_) in ((-10.45, -5.75, 13), (-9.3, -6.15, 9), (-10.2, -6.95, 6)):
        box("white2", (cx, cy, QZ + 0.05), (1.3, 0.96, 0.1), r=0.015, rz=ang)
        for k in range(n_):
            box("dull", (cx + _rs.uniform(-0.015, 0.015), cy + _rs.uniform(-0.015, 0.015), QZ + 0.13 + k * 0.058), (1.18, 0.84, 0.046), r=0.004, rz=ang + _rs.uniform(-0.012, 0.012), seg=1)
    # finished panels pile up along the water, the first proof of progress
    rack((-5.5, -8.3, QZ), math.radians(-52), 5, live="yard")
    rack((-7.5, -8.0, QZ), math.radians(-52), 6, live="yard")
    rack((-9.5, -7.5, QZ), math.radians(-52), 7, live="yard")
    # the loading bay: this bot carries a polished panel across to the waiting pod
    bx, by = -3.4, -7.2
    fc = face_toward(bx, by, -2.05, -6.89, limit=math.radians(30))
    bot_pad(bx, by, QZ, 0.68, "foundry")
    place_bot("foundry", bx, by, QZ + 0.09, fc)
    with PT.drop():
        hand_carry(bx, by, QZ + 0.09, BOTS["foundry"]["size"], fc - 0.25)
    PT.spot("over_head", (bx, by, QZ + 0.09 + BOTS["foundry"]["size"] + 0.62))
    # steps down to the water, a place to land raw stock
    t_ = math.radians(250)
    ex, ey = QX + (R + 0.02) * math.cos(t_), QY + (R + 0.02) * math.sin(t_)
    stairs(ex, ey, QZ, 0.0, t_, w=0.9, n=5, tread=0.12)
    # low hedge on the pool side, and one olive on a raised lawn, for scale
    for th0, th1 in ((168, 200),):
        polar("hedge", QX, QY, sh, [(R - 0.42, QZ), (R - 0.42, QZ + 0.11), (R - 0.38, QZ + 0.15), (R - 0.28, QZ + 0.15), (R - 0.24, QZ + 0.11), (R - 0.24, QZ)], nu=30, th0=math.radians(th0), th1=math.radians(th1))
    for x, y, h in ((-10.55, -5.2, 1.5), (-10.35, -7.0, 1.2)):
        planter(x, y, QZ, r=0.15, h=0.08, ph=h)


# ---------- station two: the inspection terrace, part way up ----------
def build_terrace():
    t0 = TERR_TH
    Rt = 2.2
    r_c = Rf(t0) + 0.55
    Dx, Dy = HX + r_c * math.cos(t0), HY + r_c * math.sin(t0)
    Zt = Zf(t0) + 0.03
    z_low = Zf(t0 - TAU)
    # the bowl that carries it, tapering down to the turn below
    H = Zt - z_low
    lathe("white2", (Dx, Dy, z_low), [(0.72, 0), (0.62, 0.1), (0.6, H * 0.34), (0.98, H * 0.62), (1.6, H * 0.84), (Rt - 0.1, H - 0.14), (Rt + 0.03, H - 0.09), (Rt + 0.06, H - 0.02), (Rt + 0.04, H + 0.05), (Rt - 0.05, H + 0.055), (Rt - 0.08, H + 0.01)], seg=112)
    polar("glazing", Dx, Dy, None, [(Rt - 0.07, Zt - 0.07), (Rt - 0.07, Zt - 0.02)], nu=80, pu=0.13, smooth=False)
    polar("chrome", Dx, Dy, None, [(Rt + 0.074, Zt - 0.075), (Rt + 0.082, Zt - 0.035), (Rt + 0.074, Zt + 0.005)], nu=120)
    for k in range(16):
        a = TAU * k / 16
        pts = []
        for q in np.linspace(0, 1, 12):
            rr = 0.66 + (Rt - 0.72) * q ** 1.7
            pts.append((Dx + rr * math.cos(a), Dy + rr * math.sin(a), z_low + 0.08 + (H - 0.2) * q))
        tube("white2", pts, 0.05, 0.022, seg=7)
    polar("deck", Dx, Dy, None, [(Rt - 0.03, Zt + 0.012), (Rt * 0.5, Zt + 0.012), (0.01, Zt + 0.012)], nu=90, planar=0.7, smooth=False)
    pts = [(Dx + Rt * math.cos(a), Dy + Rt * math.sin(a), Zt + 0.34) for a in np.linspace(0, TAU, 100)]
    tube("rail", pts, 0.009, seg=5)
    for a in np.linspace(0, TAU, 44, endpoint=False):
        cyl("rail", (Dx + Rt * math.cos(a), Dy + Rt * math.sin(a), Zt + 0.05), (Dx + Rt * math.cos(a), Dy + Rt * math.sin(a), Zt + 0.34), 0.0055, seg=4, cap=False)
    z = Zt + 0.012
    # the inspection frame: a white portal, a panel held up in it, a bar of light passing over the mirror
    gx, gy = Dx + 0.55, Dy - 0.05
    ang = math.radians(-55)
    def portal():
        w_, h_ = 1.75, 1.62
        for s_ in (-1, 1):
            lathe("white2", (gx + s_ * w_ / 2, gy, z), [(0.13, 0), (0.1, 0.05), (0.05, 0.14), (0.04, h_)], seg=14)
        pts_ = [(gx + w_ / 2 * math.cos(a), gy, z + h_ + 0.26 * math.sin(a)) for a in np.linspace(0, PI, 22)]
        tube("white2", pts_, 0.042, seg=8)
        with PT.drop():
            plate((gx - 0.355, gy, z + 0.84), 0.71, 1.02, rz=0.0, rx=-0.34, mat="chrome", sag=0.0)
            plate((gx + 0.355, gy, z + 0.84), 0.71, 1.02, rz=0.0, rx=-0.34, mat="dull", sag=0.0)
        for s_ in (-1, 1):
            box("steel", (gx + s_ * 0.78, gy, z + 0.84), (0.16, 0.05, 0.05), r=0.01)
        box("white2", (gx, gy, z + 0.21), (1.5, 0.3, 0.1), r=0.03)
        use("polish")
        with PT.drop():
            box("led_hot", (gx, gy - 0.05, z + 0.84), (0.028, 0.012, 1.12), r=0.0, rx=-0.34)
        box("white2", (gx, gy + 0.14, z + 1.38), (0.12, 0.1, 0.06), r=0.01)
        box("white2", (gx, gy - 0.24, z + 0.3), (0.12, 0.1, 0.06), r=0.01)
        use(None)
    rotated(ang, gx, gy, portal)
    if PT.ON:
        # The mirror wipes in strip by strip behind the bar, so polishing shows as a change of finish.
        c_p, s_p = math.cos(ang), math.sin(ang)
        for i in range(6):
            xo = (i - 2.5) * 0.2367
            PT.spot("strip", (gx + c_p * xo, gy + s_p * xo, z + 0.84), yaw=ang)
        with PT.actor("strip_panel", pivot=(0, 0, 0)):
            plate((0.0, 0.0, 0.0), 0.2367, 1.02, rx=-0.34, mat="dull", sag=0.0)

        def bar():
            use("polish")
            box("led_hot", (gx, gy - 0.06, z + 0.84), (0.05, 0.016, 1.12), r=0.0, rx=-0.34)
            cyl("dull", (gx, gy - 0.07, z + 0.84), (gx, gy - 0.1, z + 0.84), 0.12, seg=20)
            cyl("white2", (gx, gy - 0.1, z + 0.84), (gx, gy - 0.135, z + 0.84), 0.05, seg=12)
            use(None)
        with PT.actor("scan", pivot=(gx, gy, z + 0.84)):
            rotated(ang, gx, gy, bar)
        PT.spot("scan_end", (gx + c_p, gy + s_p, z + 0.84))
    # the bot, turned to its panel with a floating magnifier, and a polishing disc working the mirror
    c_a, s_a = math.cos(ang), math.sin(ang)
    bx, by = Dx - 0.92, Dy - 0.92
    bot_pad(bx, by, z, 0.72, "polish")
    fc = face_toward(bx, by, gx, gy, limit=math.radians(20))
    place_bot("polish", bx, by, z + 0.09, fc, prop="magnifier", side="right", scale=1.25, lift=0.06)
    # waiting panels still dull, finished ones bright, side by side
    rack((Dx - 1.25, Dy + 0.72, z), math.radians(-50), 3, mat="dull", w=0.9, h=0.62, live="waiting")
    rack((Dx + 1.55, Dy - 0.75, z), math.radians(-58), 4, w=0.8, h=0.56, gap=0.18, lit="ok", live="finished")
    use(None)
    return Dx, Dy, Zt


# ---------- station three: the summit, where the ring goes together ----------
RM = 3.5
A_, B_ = 0.62, 0.42
YR = math.radians(13)
E1 = np.array((math.cos(YR), math.sin(YR), 0.0))
E3 = np.array((-math.sin(YR), math.cos(YR), 0.0))
E2 = np.array((0.0, 0.0, 1.0))


def ring_fn(ph0, ph1, ps0, ps1, ex=0.82):
    C = np.array((HX, HY, Z1_ + 0.04 + RM - 0.18))

    def f(u, v, off):
        ph = ph0 + (ph1 - ph0) * u
        ps = ps0 + (ps1 - ps0) * v
        cs, sn = np.cos(ps), np.sin(ps)
        rr = RM + (B_ + off) * np.sign(cs) * np.abs(cs) ** ex
        ax = (A_ + off) * np.sign(sn) * np.abs(sn) ** ex
        return C + np.outer(rr * np.cos(ph), E1) + np.outer(rr * np.sin(ph), E2) + np.outer(ax, E3)

    return f, C


def tower(cx, cy, z0, z1, sx=0.62, sy=0.62, dz=0.82):
    """Plain scaffold: four legs, a ledger at every lift, one diagonal each way."""
    legs = [(cx - sx, cy - sy), (cx + sx, cy - sy), (cx + sx, cy + sy), (cx - sx, cy + sy)]
    for x, y in legs:
        cyl("steel", (x, y, z0), (x, y, z1), 0.022, seg=6, cap=False)
    z = z0
    k = 0
    while z < z1 - 0.01:
        z2 = min(z + dz, z1)
        for i in range(4):
            a, b = legs[i], legs[(i + 1) % 4]
            cyl("steel", (a[0], a[1], z2), (b[0], b[1], z2), 0.015, seg=5, cap=False)
            if (k + i) % 2 == 0:
                cyl("rail", (a[0], a[1], z), (b[0], b[1], z2), 0.009, seg=4, cap=False)
            else:
                cyl("rail", (b[0], b[1], z), (a[0], a[1], z2), 0.009, seg=4, cap=False)
        z = z2
        k += 1


def build_summit():
    r2 = math.radians
    tip_r, tip_l = r2(5), r2(-235)     # the mirror runs from the right horn, under, and over to the upper left
    f, C = ring_fn(tip_r, tip_l, r2(-112), r2(112))
    # More tilt per panel than before: the reflection breaks into a mosaic of sky, cloud and sun rather than one smear.
    panels("chrome", f, 32, 6, sub=5, gap=0.016, jitter=0.55, seed=12, inset=0.018, stagger=True)
    # a staggered leading edge at both horns
    for ph0, ph1, ps0, ps1, sd in ((tip_r, tip_r + r2(7.5), r2(-40), r2(75), 31), (tip_l, tip_l - r2(7.5), r2(-75), r2(40), 32)):
        fx, _ = ring_fn(ph0, ph1, ps0, ps1)
        panels("chrome", fx, 1, 3, sub=5, gap=0.02, jitter=0.25, seed=sd, inset=0.018)
    # the inner lip of the finished part
    fi, _ = ring_fn(tip_r, tip_l, r2(112), r2(248))
    U, W = np.meshgrid(np.linspace(0, 1, 241), np.linspace(0, 1, 7), indexing="xy")
    Pl = fi(U.ravel(), W.ravel(), 0.0).reshape(7, 241, 3)
    uv = np.zeros((7, 241, 2))
    uv[:, :, 0] = U * 32
    uv[:, :, 1] = W * 2
    loft("white2", Pl, uv=uv)
    use("lead")
    fl, _ = ring_fn(tip_r, tip_l, r2(176), r2(184))
    U, W = np.meshgrid(np.linspace(0, 1, 241), np.linspace(0, 1, 2), indexing="xy")
    loft("led_hot", fl(U.ravel(), W.ravel(), 0.008).reshape(2, 241, 3))
    use(None)
    # the skeleton still to be clad closes the circle, so the eye reads what it will become
    gap_a, gap_b = tip_r - r2(2), tip_l + TAU + r2(2)
    fs, _ = ring_fn(0, 1, 0, 1)
    def fr(ph, ps, off=-0.03):
        cs, sn = np.cos(ps), np.sin(ps)
        rr = RM + (B_ + off) * np.sign(cs) * np.abs(cs) ** 0.82
        ax = (A_ + off) * np.sign(sn) * np.abs(sn) ** 0.82
        return C + np.outer(rr * np.cos(ph), E1) + np.outer(rr * np.sin(ph), E2) + np.outer(ax, E3)
    for ph in np.arange(gap_a, gap_b + 0.01, r2(9.0)):
        ps = np.linspace(0, TAU, 25)
        hoop = fr(np.full(25, ph), ps)
        tube("white2", hoop, 0.023, seg=6)
    for ps0 in (0.0, r2(70), r2(-70), r2(180), r2(115), r2(-115)):
        ph = np.linspace(gap_a - r2(10), gap_b + r2(10), 70)
        tube("steel", fr(ph, np.full(70, ps0)), 0.026, seg=6)
    for i_, ph in enumerate(np.arange(gap_a, gap_b - r2(8.9), r2(9.0))):
        for p0_, p1_ in ((-70, 70), (110, 250)):
            a_, b_ = (p0_, p1_) if i_ % 2 == 0 else (p1_, p0_)
            q0 = fr(np.array((ph,)), np.array((r2(a_),)))[0]
            q1 = fr(np.array((ph + r2(9.0),)), np.array((r2(b_),)))[0]
            cyl("rail", q0, q1, 0.011, seg=4, cap=False)
    # slim white clasps round the finished arc, so its size can be counted
    for ph in np.arange(tip_l + r2(15), tip_r - r2(8), r2(30)):
        tube("white2", fr(np.full(26, ph), np.linspace(r2(-116), r2(116), 26), 0.016), 0.022, seg=6)
    # falsework inside the ring, holding up the arc that is not clad yet
    Fw = np.array((HX, HY, 0.0)) + E1 * 2.2
    arc_z = float(C[2]) + math.sqrt(max((RM - B_) ** 2 - 2.2 ** 2, 0.0))
    tower(float(Fw[0]), float(Fw[1]), Z1_ + 0.05, arc_z + 0.05, sx=0.26, sy=0.42, dz=0.72)
    # The erector: an arm on the ring's own axis, in a plane just in front of the ring, like the one that lines a tunnel.
    ARM_OFF, ARM_R, PICK = 1.24, 3.53, r2(7)
    Cf = C - E3 * ARM_OFF
    for k in (-0.07, 0.07):
        cyl("steel", C + E1 * 1.96 + E2 * k, C + E2 * k, 0.026, seg=6)
    cyl("steel", C + E1 * 1.96 - E2 * 1.45, C + E1 * 0.06, 0.016, seg=5)
    cyl("white2", C + E3 * 0.08, Cf + E3 * 0.12, 0.085, seg=14)
    cyl("white2", Cf + E3 * 0.16, Cf + E3 * 0.03, 0.25, seg=30)
    use("lead")
    torus("led_on", Cf + E3 * 0.022, 0.2, 0.014, n=40, sides=6, rx=PI / 2, rz=YR)
    use(None)
    PT.spot("ring_center", C)
    PT.spot("ring_axis", C - E3)
    PT.spot("ring_e1", C + E1)
    PT.spot("ring_e2", C + E2)
    PT.spot("ring_front", Cf, arm_r=ARM_R, pick=PICK, tip_r=tip_r, tip_l=tip_l)
    if PT.ON:
        mid_ = tip_r + r2(7.5)
        PT.spot("section_grip", C + ARM_R * (math.cos(mid_) * E1 + math.sin(mid_) * E2))
        with PT.actor("section", pivot=C):
            fa, _ = ring_fn(tip_r, tip_r + r2(15), r2(-112), r2(112))
            panels("chrome", lambda u_, v_, o_: fa(u_, v_, o_ + 0.006), 2, 6, sub=5, gap=0.016, jitter=0.55, seed=77, inset=0.018)
            fb, _ = ring_fn(tip_r, tip_r + r2(15), r2(112), r2(248))
            Ux, Wx = np.meshgrid(np.linspace(0, 1, 17), np.linspace(0, 1, 5), indexing="xy")
            loft("white2", fb(Ux.ravel(), Wx.ravel(), 0.004).reshape(5, 17, 3))
            use("lead")
            fg, _ = ring_fn(tip_r, tip_r + r2(15), r2(176), r2(184))
            Ux, Wx = np.meshgrid(np.linspace(0, 1, 17), np.linspace(0, 1, 2), indexing="xy")
            loft("led_hot", fg(Ux.ravel(), Wx.ravel(), 0.012).reshape(2, 17, 3))
            use(None)
        with PT.actor("ring_shell", pivot=C):
            fz, _ = ring_fn(0.0, TAU, -PI, PI)
            Ux, Wx = np.meshgrid(np.linspace(0, 1, 181), np.linspace(0, 1, 17), indexing="xy")
            loft("white2", fz(Ux.ravel(), Wx.ravel(), 0.03).reshape(17, 181, 3))
        with PT.actor("arm", pivot=Cf):
            tip_ = Cf + E1 * ARM_R
            back_ = Cf - E1 * 1.15
            for k in (-0.06, 0.06):
                cyl("white2", back_ + E2 * k, tip_ - E1 * 0.1 + E2 * k * 0.6, 0.026, seg=7)
            for i in range(8):
                x0_ = 0.2 + i * (ARM_R - 0.4) / 8
                sg = 1 if i % 2 == 0 else -1
                cyl("rail", Cf + E1 * x0_ + E2 * 0.05 * sg, Cf + E1 * (x0_ + (ARM_R - 0.4) / 8) - E2 * 0.05 * sg, 0.01, seg=4, cap=False)
            box("white2", back_, (0.5, 0.24, 0.34), r=0.03, rz=YR)
            cyl("steel", tip_ - E2 * 0.42, tip_ + E2 * 0.42, 0.024, seg=6)
            for k in (-0.42, 0.42):
                cyl("steel", tip_ + E2 * k, tip_ + E2 * k + E3 * 0.12, 0.016, seg=5)
        with PT.actor("trolley", pivot=(0, 0, 0)):
            box("white2", (0.0, 0.0, -0.06), (0.3, 0.2, 0.12), r=0.025)
            cyl("steel", (0.0, -0.08, -0.15), (0.0, 0.08, -0.15), 0.05, seg=10)
        with PT.actor("hook", pivot=(0, 0, 0)):
            box("white2", (0.0, 0.0, 0.0), (0.2, 0.12, 0.16), r=0.02)
            cyl("steel", (0.0, 0.0, -0.08), (0.0, 0.0, -0.26), 0.016, seg=6)
        with PT.actor("cable", pivot=(0, 0, 0)):
            cyl("rail", (0.0, 0.0, 0.0), (0.0, 0.0, -1.0), 0.011, seg=5, cap=False)
    # the foot of the ring, a low cradle of ribbons and white ribs that hand it its weight
    sh = blob(0.16, 0.02, 0.4, 1.0)
    Zd = Z1_ + 0.04
    for k in range(3):
        t0, t1 = k / 3, (k + 1) / 3
        rr0, rr1 = 2.3 * (1 - (t0 * 0.76) ** 2.4) ** 0.5, 2.3 * (1 - (t1 * 0.76) ** 2.4) ** 0.5
        band(HX, HY, sh, rr0, Zd + 0.6 * t0, Zd + 0.6 * t1, pu=0.7, rec=0.08, bulge=0.02, win=0.4, r_top=rr1, nu=180)
    fill("deck", HX, HY, sh, rr1, Zd + 0.6, nu=100, planar=0.7)
    for s_ in (-1, 1):
        for k in range(6):
            th = r2(-90 + s_ * (24 + 8.5 * k))
            if s_ > 0 and th > tip_r - r2(14):
                continue
            top = C + (RM + B_ * 0.2) * (math.cos(th) * E1 + math.sin(th) * E2)
            for face in (-1, 1):
                t_ = top + E3 * face * (A_ * 0.98)
                foot = np.array((HX + E1[0] * s_ * (1.45 + 0.2 * k), HY + E1[1] * s_ * (1.45 + 0.2 * k), Zd)) + E3 * face * (1.15 - 0.05 * k)
                mid = (t_ + foot) / 2 + E3 * face * 0.2 + np.array((0, 0, -0.12))
                tube("white2", [(1 - q) ** 2 * foot + 2 * q * (1 - q) * mid + q * q * t_ for q in np.linspace(0, 1, 14)], 0.055, 0.03, seg=8)
    # the scaffold and the crane, at the right horn where the work is
    Tc = np.array((HX, HY, 0.0)) + E1 * 5.05
    TX, TY = float(Tc[0]), float(Tc[1])
    lathe("white2", (TX, TY, Z1_ - 0.75), [(0.45, 0.0), (0.5, 0.1), (1.05, 0.5), (1.52, 0.68), (1.56, 0.74), (1.54, 0.8), (1.46, 0.81), (0.001, 0.81)], seg=72)
    Zl = Z1_ + 0.06
    tower(TX, TY, Zl, 12.4)
    # a second, lighter run of scaffold along the skeleton
    for ph in (r2(38), r2(66), r2(94)):
        q = C + (RM + B_ + 0.32) * (math.cos(ph) * E1 + math.sin(ph) * E2)
        for fc in (-1, 1):
            p_ = q + E3 * fc * (A_ + 0.2)
            cyl("rail", p_, (C + (RM - 0.2) * (math.cos(ph) * E1 + math.sin(ph) * E2)) + E3 * fc * (A_ + 0.2), 0.011, seg=4, cap=False)
        cyl("rail", q + E3 * (A_ + 0.2), q - E3 * (A_ + 0.2), 0.011, seg=4, cap=False)
    # the work platform, level with the leading edge
    Zp = float(C[2]) - 0.5
    Px = Tc - E1 * 0.125 - E3 * 0.625
    box("white2", (float(Px[0]), float(Px[1]), Zp - 0.05), (1.85, 2.95, 0.08), r=0.025, rz=YR)
    for k in (-1, 1):
        q0 = Px + E3 * k * 1.45 - E1 * 0.9
        q1 = Px + E3 * k * 1.45 + E1 * 0.9
        cyl("rail", (q0[0], q0[1], Zp + 0.3), (q1[0], q1[1], Zp + 0.3), 0.008, seg=4, cap=False)
    for k in (-0.62, 0.62):
        q0 = Tc + E1 * k - E3 * 0.62
        q1 = Px + E1 * k - E3 * 1.42
        cyl("steel", (q0[0], q0[1], Zp - 1.5), (q1[0], q1[1], Zp - 0.08), 0.02, seg=6, cap=False)
    # the white lead on its black stage, out in front of the tower, facing the mirror it is closing
    Lc = np.array((HX, HY, 0.0)) + E1 * 4.9 - E3 * 1.35
    LX_, LY_ = float(Lc[0]), float(Lc[1])
    bot_pad(LX_, LY_, Zp, 0.74, "lead", shell=1.02)
    # the next panel hangs from the crane, turned to the sun, on its way into the gap
    tipa = r2(25)
    pc = C + (RM + 0.1) * (math.cos(tipa) * E1 + math.sin(tipa) * E2) - E3 * (A_ + 0.42)
    place_bot("lead", LX_, LY_, Zp + 0.11, face_toward(LX_, LY_, float(pc[0]), float(pc[1]), limit=r2(34)), prop="wrench", side="left", scale=1.2)
    point((LX_ - 1.0, LY_ - 1.9, Zp + 1.5), (1.0, 0.95, 0.9), 32.0, r=0.6)
    with PT.drop():
        plate(pc, 1.62, 1.18, rz=YR - 0.2, rx=-0.24, mat="chrome", sag=0.2)
        glint(C + (RM + B_ * 0.6) * (math.cos(tip_r + r2(2)) * E1 + math.sin(tip_r + r2(2)) * E2) - E3 * (A_ * 0.9), 0.15)
    # the crane: a white jib off the tower, a hook line and slings down to the panel, a second hoist bringing up the next
    Jz = 12.5
    rack_xy = (HX + 2.8, HY - 1.55)
    Jtip = np.array(rack_xy)
    tube("white2", [(TX + E1[0] * 0.95, TY + E1[1] * 0.95, Jz), (TX, TY, Jz + 0.06), (Jtip[0], Jtip[1], Jz + 0.03)], 0.05, 0.022, seg=7)
    with PT.drop():
        for k in (-0.62, 0.62):
            q_ = pc + (math.cos(YR - 0.2) * k, math.sin(YR - 0.2) * k, 0.59)
            cyl("rail", q_, pc + (0, 0, 1.15), 0.005, seg=4, cap=False)
        cyl("rail", (pc[0], pc[1], pc[2] + 1.15), (pc[0], pc[1], Jz), 0.007, seg=4, cap=False)
    # a truss under the jib, so it reads as a real crane at this distance
    jr_ = np.array((TX, TY, Jz - 0.34))
    jt_ = np.array((Jtip[0], Jtip[1], Jz - 0.02))
    tube("white2", [jr_, jt_], 0.026, 0.016, seg=6)
    for i in range(9):
        a_ = i / 9
        b_ = (i + 1) / 9
        top0 = np.array((TX + (Jtip[0] - TX) * a_, TY + (Jtip[1] - TY) * a_, Jz + 0.05))
        low1 = jr_ + (jt_ - jr_) * b_
        cyl("rail", top0, low1, 0.009, seg=4, cap=False)
    PT.spot("jib_root", (TX, TY, Jz - 0.02))
    PT.spot("jib_tip", (Jtip[0], Jtip[1], Jz - 0.02))
    cyl("steel", (TX, TY, Jz - 0.1), (TX, TY, Jz + 0.46), 0.03, seg=8, cap=False)
    tube("rail", [(TX, TY, Jz + 0.46), (Jtip[0], Jtip[1], Jz + 0.05)], 0.005, seg=4)
    tube("rail", [(TX, TY, Jz + 0.46), (TX + E1[0] * 0.95, TY + E1[1] * 0.95, Jz)], 0.005, seg=4)
    cw = Tc + E1 * 0.82 + E3 * -0.72
    # the second hoist on the tower's near face, panel on its way up
    hx_, hy_ = float(cw[0]), float(cw[1])
    with PT.drop():
        cyl("rail", (hx_, hy_, 7.9), (hx_, hy_, Jz), 0.006, seg=4, cap=False)
        plate((hx_, hy_, 7.45), 0.9, 0.64, rz=YR + 0.32, rx=0.03, mat="chrome")
    # the last pod arrives and unloads into a rack that is nearly empty now
    box("white2", (rack_xy[0], rack_xy[1], Zd - 0.2), (1.1, 0.96, 0.42), r=0.04, rz=math.radians(38))
    rack((rack_xy[0], rack_xy[1], Zd), math.radians(38), 4, w=0.9, h=0.62, gap=0.18, live="summit_rack")
    for x_, y_, h_ in ((HX - 2.6, HY - 2.5, 1.25), (HX - 3.05, HY - 1.95, 1.5), (HX - 1.0, HY - 3.45, 1.15)):
        planter(x_, y_, Zd, r=0.13, h=0.07, ph=h_)
    point((TX, TY, Zp + 1.6), (1.0, 0.9, 0.78), 22.0, r=0.5)


# ---------- the pool, with the citadel standing in it ----------
def build_water():
    V = np.array([(-500, -500, 0), (500, -500, 0), (500, 500, 0), (-500, 500, 0)], float)
    mesh_obj("pool", V, [(0, 1, 2, 3)], "pool", smooth=False)
    polar("shelf", HX, HY, None, [(R0_ + 1.5, 0.003), (R0_ - 0.3, 0.003)], nu=200, smooth=False)
    polar("shelf2", HX, HY, None, [(R0_ + 3.1, 0.0015), (R0_ + 1.5, 0.0015)], nu=200, smooth=False)
    sh = blob(0.09, 0.05, 0.6, 1.8, 0.012, 0.0)
    polar("shelf", QX, QY, sh, [(5.2, 0.0035), (3.8, 0.0035)], nu=180, smooth=False)
    polar("shelf2", QX, QY, sh, [(6.5, 0.002), (5.2, 0.002)], nu=180, smooth=False)
    rnd = random.Random(21)
    for _ in range(9):
        a = rnd.uniform(math.radians(205), math.radians(345))
        r = rnd.uniform(R0_ + 1.4, R0_ + 6.5)
        x, y = HX + r * math.cos(a), HY + r * math.sin(a)
        if math.hypot(x - QX, y - QY) < 5.2:
            continue
        for _k in range(26):
            lily_pad(x + rnd.gauss(0, 0.5), y + rnd.gauss(0, 0.5), rnd, big=2.2)
    for x, y, h in ((9.8, -9.7, 1.6), (12.2, -7.2, 1.25)):
        planter(x, y, -0.02, r=0.3, h=0.13, ph=h)


def lily_pad(x, y, rnd, big=1.0):
    r = rnd.uniform(0.035, 0.085) * big
    n = 12
    notch = rnd.uniform(0, TAU)
    V = [(x, y, 0.008)]
    for i in range(n):
        t = notch + 0.35 + (TAU - 0.7) * i / (n - 1)
        V.append((x + r * math.cos(t), y + r * math.sin(t), 0.008))
    F = [(0, i + 1, i + 2) for i in range(n - 1)]
    G.add("lily", V, F, [False] * len(F))
    if rnd.random() < 0.08:
        sphere("petal" if rnd.random() < 0.6 else "petal2", (x, y, 0.03), 0.028 * big, seg=8, rings=5, sc=(1, 1, 0.7))


build_hill()
guideway()
build_foundry()
terr = build_terrace()
build_summit()
build_water()


def mirror_sail(x, y, h, rz, w=0.62):
    """A tall blade of mirror in the pool. It holds the sky and stands on its own reflection."""
    c, s = math.cos(rz), math.sin(rz)
    q_ = np.linspace(0, 1, 28)
    side = np.linspace(-1, 1, 7)
    P = []
    for t in q_:
        half = w * (1 - t ** 1.7) ** 0.8 * (0.6 + 0.4 * math.sin(min(1.0, t * 3.0) * PI / 2))
        row = []
        for k in side:
            lx = half * k + 0.42 * t * t
            ly = 0.13 * (1 - k * k) * (1 - t)
            row.append((x + c * lx - s * ly, y + s * lx + c * ly, 0.02 + h * t))
        P.append(row)
    P = np.array(P)
    loft("chrome", P)
    tube("white2", P[:, 0], 0.02, 0.006, seg=6)
    tube("white2", P[:, -1], 0.02, 0.006, seg=6)
    box("white2", (x, y, 0.03), (w * 1.5, 0.2, 0.12), r=0.04, rz=rz)


pod_gate(math.radians(204))
pod_gate(math.radians(1080))
PT.path("podway", [pt(math.radians(d), GUIDE, GZ + 0.28) for d in range(196, 1106, 3)])
# pods in transit, the work moving up the hill. The first waits half loaded at the bay.
with PT.drop():
    pod(math.radians(236), "foundry", load=1)
with PT.drop():
    pod(math.radians(316), "foundry", load=2)
with PT.drop():
    pod(math.radians(578), "foundry", load=2, mat="dull")
with PT.drop():
    pod(math.radians(626), "foundry", load=2, mat="dull")
with PT.drop():
    pod(math.radians(662), "foundry", load=2, mat="dull")
with PT.drop():
    pod(math.radians(716), "polish", load=2)
with PT.drop():
    pod(math.radians(958), "polish", load=2)
with PT.drop():
    pod(math.radians(1016), "polish", load=2)
with PT.drop():
    pod(math.radians(1072), "polish", load=1)
print("citadel built", flush=True)
if PT.ON:
    with PT.actor("panel", pivot=(0, 0, 0)):
        plate((0.0, 0.0, 0.0), 1.0, 0.72, rx=-0.26, mat="chrome", sag=0.045)
    with PT.actor("panel_dull", pivot=(0, 0, 0)):
        plate((0.0, 0.0, 0.0), 1.0, 0.72, rx=-0.26, mat="dull", sag=0.045)
    with PT.actor("pod", pivot=(0, 0, 0)):
        pod_at((0.0, 0.0, 0.0), 0.0, "foundry", load=0)
    with PT.actor("pod_panel_a", pivot=(0, 0, 0)):
        plate((0.0, -0.085, 0.49), 0.98, 0.52, rx=-0.26, mat="chrome", sag=0.07)
    with PT.actor("pod_panel_b", pivot=(0, 0, 0)):
        plate((0.0, 0.085, 0.49), 0.98, 0.52, rx=0.26, mat="chrome", sag=0.07)
    PT.accents(
        foundry=["led_on_orange", "led_dim_orange", "led_hot_orange"],
        polish=["led_on_pink", "led_dim_pink", "led_hot_pink"],
        lead=["led_on_lead", "led_dim_lead", "led_hot_lead"],
    )
    PT.masks(water=["pool", "shelf", "shelf2", "rill"], pulse=["lamp", "hot", "beacon", "glint"])
    PT.motion(
        cypress=dict(axis="object", h=1.3, bend=1.0, phase="object"),
        hedge=dict(bend=0.16, phase_scale=4.0),
        lily=dict(bend=0.7, phase_scale=1.6),
        petal=dict(bend=0.7, phase_scale=1.6),
        petal2=dict(bend=0.7, phase_scale=1.6),
    )
    # What the live copies are made of, from the material definitions above. Metals are a fifth darker: live reflections wash them out.
    PT.flat("chrome", (0.74, 0.75, 0.77), rough=0.07, metal=1.0)
    PT.flat("dull", (0.5, 0.5, 0.52), rough=0.34, metal=1.0)
    PT.flat("steel", (0.5, 0.51, 0.54), rough=0.3, metal=1.0)
    PT.flat("rail", (0.4, 0.42, 0.44), rough=0.35, metal=1.0)
    PT.flat("white2", (0.9, 0.89, 0.87), rough=0.3)
    PT.flat("pod", (0.86, 0.87, 0.88), rough=0.14)
    PT.flat("podglass", (0.01, 0.02, 0.03), rough=0.05)


# ---------- far shore: the pool has an edge, the land goes on, the air does the rest ----------
MATS["farland"] = pbsdf("farland", (0.05, 0.09, 0.2), 0.95, emis=(0.4, 0.55, 0.84), emis_str=0.62)
MATS["farhill"] = pbsdf("farhill", (0.3, 0.42, 0.56), 0.95)
MATS["farwhite"] = pbsdf("farwhite", (0.62, 0.7, 0.86), 0.6, emis=(0.6, 0.72, 0.95), emis_str=0.25)
MATS["farglass"] = pbsdf("farglass", (0.2, 0.3, 0.44), 0.2)
FY = 150.0
X_ = np.linspace(-320, 320, 260)
Y_ = np.linspace(FY - 0.5, FY + 300, 90)
V_ = []
for y in Y_:
    for x in X_:
        d = y - FY
        h = 0.4 + 0.007 * d + (0.024 + 0.05 * min(d / 120.0, 1.0)) * d * 0.5 * max(0.0, noise.fractal(Vector((x * 0.012, y * 0.012, 3.0)), 1.0, 2.0, 4) + 0.28)
        V_.append((x, y, h if d > 0.6 else -0.2))
F_ = [(j * 260 + i, j * 260 + i + 1, (j + 1) * 260 + i + 1, (j + 1) * 260 + i) for j in range(89) for i in range(259)]
mesh_obj("farland", np.array(V_), F_, "farland")
G.build()


def _flame(seed, seg=12, rings=16):
    V, F = [], []
    for j in range(rings + 1):
        t = j / rings
        r = 0.2 * (math.sin(PI * t ** 0.6)) ** 0.75 + 0.002
        for i in range(seg):
            a = TAU * i / seg
            w = 1 + 0.16 * noise.noise(Vector((math.cos(a) * 1.6 + seed, math.sin(a) * 1.6, t * 7)))
            V.append((r * w * math.cos(a), r * w * math.sin(a), t))
    for j in range(rings):
        for i in range(seg):
            a, b = j * seg + i, j * seg + (i + 1) % seg
            F.append((a, b, b + seg, a + seg))
    me = bpy.data.meshes.new(f"cyp{seed}")
    me.from_pydata(V, [], F)
    me.polygons.foreach_set("use_smooth", [True] * len(me.polygons))
    me.update()
    me.materials.append(MATS["cypress"])
    return me


CYP = [_flame(s) for s in (1, 2, 3)]


def plant(mesh, x, y, h, z=0.0):
    o = bpy.data.objects.new("tree", mesh)
    o.location = (x, y, z - 0.02)
    o.scale = (h * random.uniform(0.92, 1.1), h * random.uniform(0.92, 1.1), h)
    o.rotation_euler = (0, 0, random.uniform(0, 6.28))
    bpy.context.collection.objects.link(o)


random.seed(5)


# ---------- sky: a real one, because mirrors only look good with something to hold ----------
SUN_DIR = Vector((-0.88, -0.3, 0.34)).normalized()


def build_sky():
    w = bpy.data.worlds.new("sky")
    bpy.context.scene.world = w
    w.use_nodes = True
    nt = w.node_tree
    bg = nt.nodes["Background"]
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(tc.outputs["Generated"], sep.inputs[0])
    rp = nt.nodes.new("ShaderNodeValToRGB")
    c = rp.color_ramp
    c.elements[0].position, c.elements[0].color = 0.0, (1.0, 0.76, 0.52, 1)
    c.elements[1].position, c.elements[1].color = 1.0, (0.02, 0.075, 0.3, 1)
    c.elements.new(0.018).color = (0.8, 0.74, 0.72, 1)
    c.elements.new(0.08).color = (0.2, 0.42, 0.86, 1)
    c.elements.new(0.2).color = (0.07, 0.25, 0.7, 1)
    c.elements.new(0.5).color = (0.04, 0.15, 0.5, 1)
    nt.links.new(sep.outputs["Z"], rp.inputs["Fac"])
    mp = nt.nodes.new("ShaderNodeMapping")
    mp.inputs["Scale"].default_value = (3.0, 3.0, 11.0)
    mp.inputs["Location"].default_value = (7.1, 4.6, 0.0)
    nt.links.new(tc.outputs["Generated"], mp.inputs["Vector"])

    def clouds(vec):
        n1 = nt.nodes.new("ShaderNodeTexNoise")
        n1.inputs["Scale"].default_value = 1.15
        n1.inputs["Detail"].default_value = 9
        n1.inputs["Roughness"].default_value = 0.56
        n1.inputs["Lacunarity"].default_value = 2.15
        nt.links.new(vec, n1.inputs["Vector"])
        return n1.outputs["Fac"]

    d1 = clouds(mp.outputs[0])
    of = nt.nodes.new("ShaderNodeVectorMath")
    of.operation = "ADD"
    of.inputs[1].default_value = (SUN_DIR.x * 0.25, SUN_DIR.y * 0.25, 0.75)
    nt.links.new(mp.outputs[0], of.inputs[0])
    d2 = clouds(of.outputs[0])
    cov = _range(nt, d1, 0.54, 0.585)
    lit = _range(nt, _math(nt, "SUBTRACT", d1, d2), -0.08, 0.07)
    cc = _mix(nt, (0.5, 0.57, 0.76, 1), (2.6, 2.3, 1.95, 1), lit)
    fade = _range(nt, sep.outputs["Z"], 0.004, 0.03)
    cov2 = _math(nt, "MULTIPLY", _math(nt, "MULTIPLY", cov, fade), _range(nt, sep.outputs["Z"], 0.3, 0.55, 1.0, 0.12))
    mixed = _mix(nt, rp.outputs["Color"], cc, cov2)
    dot = nt.nodes.new("ShaderNodeVectorMath")
    dot.operation = "DOT_PRODUCT"
    dot.inputs[1].default_value = SUN_DIR
    nt.links.new(tc.outputs["Generated"], dot.inputs[0])
    wr = _range(nt, dot.outputs["Value"], 0.78, 0.995)
    glow = _mix(nt, (0, 0, 0, 1), (3.0, 1.55, 0.7, 1), wr)
    final = _mix(nt, mixed, glow, 1.0, "ADD")
    nt.links.new(final, bg.inputs["Color"])
    lp = nt.nodes.new("ShaderNodeLightPath")
    nt.links.new(_range(nt, lp.outputs["Is Diffuse Ray"], 0.0, 1.0, 1.15, 0.36), bg.inputs["Strength"])


build_sky()

sun = bpy.data.lights.new("sun", "SUN")
sun.energy = 12.5
sun.color = (1.0, 0.8, 0.58)
sun.angle = math.radians(3.0)
so = bpy.data.objects.new("sun", sun)
so.rotation_euler = SUN_DIR.to_track_quat("Z", "Y").to_euler()
bpy.context.collection.objects.link(so)

# a break in the cloud on the summit, along the sun so shadows stay single
_tg = Vector((HX, HY, 8.5))
_sp = bpy.data.lights.new("break", "SPOT")
_sp.energy = 42000.0
_sp.color = (1.0, 0.8, 0.58)
_sp.spot_size = math.radians(18)
_sp.spot_blend = 1.0
_sp.shadow_soft_size = 1.2
_spo = bpy.data.objects.new("break", _sp)
_spo.location = _tg + SUN_DIR * 52
_spo.rotation_euler = SUN_DIR.to_track_quat("Z", "Y").to_euler()
_spo.visible_glossy = False
bpy.context.collection.objects.link(_spo)

# ---------- camera: from the side, low three quarter, so it reads as a hill ----------
cd = bpy.data.cameras.new("cam")
cd.lens = 48
cd.sensor_width = 36
co = bpy.data.objects.new("cam", cd)
CP = Vector((CAM_XY[0], CAM_XY[1], 7.1))
TG = Vector((1.0, -1.0, 5.25))
FD = 37.5
CAMS = dict(
    foundry=(Vector((-4.9, -17.0, 2.0)), Vector((-2.6, -7.0, 1.4)), 10.0),
    terrace=(Vector((2.27, -15.6, 4.8)), Vector((7.0, -6.0, 3.9)), 10.5),
    summit=(Vector((-1.0, -22.0, 8.2)), Vector((6.2, 0.0, 8.8)), 24.0),
    lead=(Vector((4.07, -8.5, 9.2)), Vector((6.6, -0.2, 8.9)), 9.0),
)
if FLAGS.get("cam") in CAMS:
    CP, TG, FD = CAMS[FLAGS["cam"]]
co.location = CP
co.rotation_euler = (TG - CP).to_track_quat("-Z", "Y").to_euler()
bpy.context.collection.objects.link(co)
bpy.context.scene.camera = co
cd.dof.use_dof = True
cd.dof.focus_distance = FD
cd.dof.aperture_fstop = 0.7
cd.dof.aperture_blades = 0

# ---------- render ----------
sc = bpy.context.scene
sc.render.engine = "CYCLES"
prefs = bpy.context.preferences.addons["cycles"].preferences
prefs.compute_device_type = "METAL"
prefs.get_devices()
for d in prefs.devices:
    d.use = d.type == "METAL"
sc.cycles.device = "GPU"
sc.cycles.samples = SAMPLES
sc.cycles.use_denoising = True
sc.cycles.denoiser = "OPENIMAGEDENOISE"
sc.cycles.max_bounces = 9
sc.cycles.glossy_bounces = 6
sc.cycles.diffuse_bounces = 3
sc.cycles.caustics_reflective = False
sc.cycles.caustics_refractive = False
sc.cycles.sample_clamp_direct = 18.0
sc.cycles.sample_clamp_indirect = 6.0
sc.render.resolution_x = WIDTH
sc.render.resolution_y = round(WIDTH * 9 / 16)
sc.render.resolution_percentage = 100
sc.render.image_settings.file_format = "PNG"
sc.render.filepath = OUT
sc.view_settings.view_transform = "AgX"
sc.view_settings.look = "AgX - Punchy"
sc.view_settings.exposure = 0.52
try:
    tree = bpy.data.node_groups.new("post", "CompositorNodeTree")
    tree.interface.new_socket(name="Image", in_out="OUTPUT", socket_type="NodeSocketColor")
    sc.compositing_node_group = tree
    rl = tree.nodes.new("CompositorNodeRLayers")
    gl = tree.nodes.new("CompositorNodeGlare")
    gl.inputs["Type"].default_value = "Bloom"
    gl.inputs["Quality"].default_value = "High"
    for nm, val in (("Threshold", 2.2), ("Smoothness", 0.8), ("Strength", 0.7), ("Saturation", 1.2), ("Size", 0.66)):
        gl.inputs[nm].default_value = val
    ou = tree.nodes.new("NodeGroupOutput")
    tree.links.new(rl.outputs["Image"], gl.inputs["Image"])
    tree.links.new(gl.outputs["Image"], ou.inputs[0])
    sc.render.use_compositing = True
except Exception as ex:
    print("POST SKIPPED", repr(ex), flush=True)
    sc.compositing_node_group = None
    sc.render.use_compositing = False
if SAVE:
    bpy.ops.wm.save_as_mainfile(filepath=SAVE)
if PT.ON:
    # On the camera side of the hill, in open air: panels facing the camera must hold sky and pool, not the inside of the hill.
    # The LED strips take the bot's colour at run time. If they also lit the walls in the accent pass, the whole hill would tint.
    for _o in bpy.data.objects:
        if _o.type == "MESH" and _o.data.materials and _o.data.materials[0] and _o.data.materials[0].name.startswith("led_"):
            _o.visible_diffuse = False
    PT.finish(co, env_center=Vector((0.0, -12.0, 5.0)))
    sys.exit(0)
tris = sum(len(o.data.polygons) for o in bpy.data.objects if o.type == "MESH" and o.name != "tree")
print("objects", len(bpy.data.objects), "faces (without tree instances)", tris, flush=True)
bpy.ops.render.render(write_still=True)
print("DONE", OUT, flush=True)
