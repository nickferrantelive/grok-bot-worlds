"""Orbit Port: four bots move cargo along one docking spine, from a ship at the arrivals bay to a launch rail. All metal, deep space, thin planet limb low in frame.

Run through the queue:
  tools/render.sh blender/orbit-port/island_look.py look/orbit-port_team_v2.png 1920 200
"""
import math
import os
import random
import sys
from contextlib import contextmanager

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector, noise

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "shared"))
import mascots
import plate_tools as PT

ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = ARGS[0] if ARGS else "/tmp/orbit.png"
WIDTH = int(ARGS[1]) if len(ARGS) > 1 else 1280
SAMPLES = int(ARGS[2]) if len(ARGS) > 2 else 48
SAVE = None
CROP = None
for _i, _a in enumerate(ARGS[3:], start=3):
    if _a.endswith(".blend"):
        SAVE = _a
    elif _a == "--crop":
        CROP = [float(v) for v in ARGS[_i + 1:_i + 5]]

random.seed(11)
np.random.seed(11)
PT.setup(ARGS, globals())

for o in list(bpy.data.objects):
    bpy.data.objects.remove(o)


# ---------- camera first: the spine is defined by where its two ends land in the frame ----------
CAM_LENS = 55.0
CAM_PITCH = math.radians(-13.0)
NEAR_F, NEAR_Z = (0.17, 0.25), 36.0     # frame x, frame y, depth of spine t = 0
FAR_F, FAR_Z = (0.665, 0.62), 64.0        # the same for the launch end
_cv0 = np.array((0.0, math.cos(CAM_PITCH), math.sin(CAM_PITCH)))
_cr0 = np.array((1.0, 0.0, 0.0))
_cu0 = np.cross(_cr0, _cv0)


def _c2w(f, z):
    return _cr0 * ((f[0] - 0.5) / (CAM_LENS / 36.0) * z) + _cu0 * ((f[1] - 0.5) / (CAM_LENS / 20.25) * z) + _cv0 * z


_near = _c2w(NEAR_F, NEAR_Z)
_far = _c2w(FAR_F, FAR_Z)
CP_np = -_near                            # spine t = 0 is the world origin
U_np = (_far - _near) / np.linalg.norm(_far - _near)
SPINE_LEN = float(np.linalg.norm(_far - _near))
W_np = np.cross(U_np, (0, 0, 1))
W_np /= np.linalg.norm(W_np)
N_np = np.cross(W_np, U_np)
SP_R = np.column_stack((W_np, U_np, N_np))   # local x = side of the spine, y = along it, z = up
print("spine len", SPINE_LEN, "U", U_np, "cam", CP_np, flush=True)

CP = Vector(CP_np.tolist())
TG = CP + Vector(_cv0.tolist()) * 46.0
FOCUS = 48.0
FSTOP = 0.5
CAMXY = (CP.x, CP.y)
SUN_DIR = Vector((0.72, -0.42, 0.55)).normalized()
LAY = dict(dist=100.0)


# ---------- shader helpers ----------
class Nodes:
    def __init__(self, nt):
        self.nt = nt
        self.tc = nt.nodes.new("ShaderNodeTexCoord")
        self.geo = nt.nodes.new("ShaderNodeNewGeometry")

    def put(self, inp, v):
        if isinstance(v, bpy.types.NodeSocket):
            self.nt.links.new(v, inp)
        else:
            inp.default_value = v

    def math(self, op, a, b=None, c=None, clamp=False):
        n = self.nt.nodes.new("ShaderNodeMath")
        n.operation = op
        n.use_clamp = clamp
        self.put(n.inputs[0], a)
        if b is not None:
            self.put(n.inputs[1], b)
        if c is not None:
            self.put(n.inputs[2], c)
        return n.outputs[0]

    def vec(self, op, a, b=None, scale=None):
        n = self.nt.nodes.new("ShaderNodeVectorMath")
        n.operation = op
        self.put(n.inputs[0], a)
        if b is not None:
            self.put(n.inputs[1], b)
        if scale is not None:
            self.put(n.inputs["Scale"], scale)
        return n.outputs["Value"] if op in ("DOT_PRODUCT", "LENGTH", "DISTANCE") else n.outputs["Vector"]

    def mapping(self, v, scale=(1, 1, 1), rot=(0, 0, 0), loc=(0, 0, 0)):
        n = self.nt.nodes.new("ShaderNodeMapping")
        self.put(n.inputs["Vector"], v)
        n.inputs["Scale"].default_value = scale
        n.inputs["Rotation"].default_value = rot
        n.inputs["Location"].default_value = loc
        return n.outputs[0]

    def noise(self, v, scale, detail=5.0, rough=0.55, dist=0.0):
        n = self.nt.nodes.new("ShaderNodeTexNoise")
        self.put(n.inputs["Vector"], v)
        n.inputs["Scale"].default_value = scale
        n.inputs["Detail"].default_value = detail
        n.inputs["Roughness"].default_value = rough
        n.inputs["Distortion"].default_value = dist
        return n

    def voronoi(self, v, scale, feature="F1", rand=1.0):
        n = self.nt.nodes.new("ShaderNodeTexVoronoi")
        n.feature = feature
        self.put(n.inputs["Vector"], v)
        n.inputs["Scale"].default_value = scale
        n.inputs["Randomness"].default_value = rand
        return n

    def ramp(self, fac, stops):
        n = self.nt.nodes.new("ShaderNodeValToRGB")
        cr = n.color_ramp
        cr.elements[0].position, cr.elements[0].color = stops[0][0], self._rgba(stops[0][1])
        cr.elements[1].position, cr.elements[1].color = stops[-1][0], self._rgba(stops[-1][1])
        for p, c in stops[1:-1]:
            cr.elements.new(p).color = self._rgba(c)
        self.put(n.inputs["Fac"], fac)
        return n.outputs["Color"]

    @staticmethod
    def _rgba(c):
        if isinstance(c, (int, float)):
            return (c, c, c, 1)
        return (*c, 1) if len(c) == 3 else c

    def mix(self, fac, a, b, blend="MIX"):
        n = self.nt.nodes.new("ShaderNodeMix")
        n.data_type = "RGBA"
        n.blend_type = blend
        self.put(n.inputs["Factor"], fac)
        self.put(n.inputs["A"], self._rgba(a) if not isinstance(a, bpy.types.NodeSocket) else a)
        self.put(n.inputs["B"], self._rgba(b) if not isinstance(b, bpy.types.NodeSocket) else b)
        return n.outputs["Result"]

    def maprange(self, v, f0, f1, t0=0.0, t1=1.0, smooth=False):
        n = self.nt.nodes.new("ShaderNodeMapRange")
        if smooth:
            n.interpolation_type = "SMOOTHSTEP"
        self.put(n.inputs["Value"], v)
        n.inputs["From Min"].default_value = f0
        n.inputs["From Max"].default_value = f1
        n.inputs["To Min"].default_value = t0
        n.inputs["To Max"].default_value = t1
        return n.outputs[0]

    def bump(self, h, strength, dist, normal=None):
        n = self.nt.nodes.new("ShaderNodeBump")
        n.inputs["Strength"].default_value = strength
        n.inputs["Distance"].default_value = dist
        self.put(n.inputs["Height"], h)
        if normal is not None:
            self.nt.links.new(normal, n.inputs["Normal"])
        return n.outputs["Normal"]


def new_mat(name):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    return m, m.node_tree, Nodes(m.node_tree), m.node_tree.nodes["Principled BSDF"]


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


def regolith_nodes(nt, N):
    """Lunar dust: warm grey, pitted, with pale mineral grains catching the sun."""
    s = nt.nodes.new("ShaderNodeBsdfPrincipled")
    o = N.tc.outputs["Object"]
    big = N.noise(o, 1.9, 6, 0.55)
    mid = N.noise(o, 11.0, 5, 0.6)
    fine = N.noise(o, 95.0, 4, 0.6)
    t = N.math("ADD", N.math("MULTIPLY", big.outputs["Fac"], 0.6), N.math("MULTIPLY", mid.outputs["Fac"], 0.4))
    col = N.ramp(t, [(0.34, (0.27, 0.245, 0.215)), (0.5, (0.45, 0.415, 0.365)), (0.68, (0.68, 0.635, 0.56))])
    grain = N.ramp(fine.outputs["Fac"], [(0.36, 0.72), (0.66, 1.08)])
    s.inputs["Roughness"].default_value = 0.94
    s.inputs["Specular IOR Level"].default_value = 0.28
    N.put(s.inputs["Base Color"], N.mix(1.0, col, grain, "MULTIPLY"))
    pit = N.voronoi(o, 13.0)
    pit2 = N.voronoi(o, 41.0)
    pits = N.ramp(pit.outputs["Distance"], [(0.0, 0.0), (0.2, 1.0)])
    pits2 = N.ramp(pit2.outputs["Distance"], [(0.0, 0.2), (0.3, 1.0)])
    h = N.math("ADD", N.math("MULTIPLY", big.outputs["Fac"], 3.0), N.math("ADD", N.math("MULTIPLY", mid.outputs["Fac"], 0.8), N.math("ADD", N.math("MULTIPLY", pits, 0.25), N.math("MULTIPLY", pits2, 0.1))))
    b1 = N.bump(h, 0.75, 0.05)
    b2 = N.bump(fine.outputs["Fac"], 0.5, 0.006, normal=b1)
    nt.links.new(b2, s.inputs["Normal"])
    return s


def mat_regolith():
    m, nt, N, p = new_mat("reg")
    nt.nodes.remove(p)
    s = regolith_nodes(nt, N)
    nt.links.new(s.outputs[0], nt.nodes["Material Output"].inputs[0])
    return m


def mat_rock():
    m, nt, N, r = new_mat("rock")
    o = N.tc.outputs["Object"]
    n1 = N.noise(o, 3.0, 10, 0.62)
    wave = nt.nodes.new("ShaderNodeTexWave")
    wave.wave_type = "BANDS"
    wave.bands_direction = "Z"
    wave.inputs["Scale"].default_value = 2.2
    wave.inputs["Distortion"].default_value = 3.4
    wave.inputs["Detail"].default_value = 5
    nt.links.new(o, wave.inputs["Vector"])
    fac = N.math("MULTIPLY_ADD", n1.outputs["Fac"], 0.6, N.math("MULTIPLY", wave.outputs["Fac"], 0.16))
    col = N.ramp(fac, [(0.34, (0.018, 0.017, 0.02)), (0.5, (0.05, 0.045, 0.044)), (0.74, (0.19, 0.15, 0.115))])
    crk = N.voronoi(o, 5.5, "DISTANCE_TO_EDGE")
    crr = N.ramp(crk.outputs["Distance"], [(0.0, 0.05), (0.045, 1.0)])
    N.put(r.inputs["Base Color"], N.mix(1.0, col, crr, "MULTIPLY"))
    r.inputs["Roughness"].default_value = 0.8
    n2 = N.noise(o, 24, 8)
    h = N.math("MULTIPLY_ADD", n2.outputs["Fac"], 0.7, crr)
    nb = N.bump(h, 0.95, 0.1)
    nt.links.new(nb, r.inputs["Normal"])
    s = regolith_nodes(nt, N)
    at = nt.nodes.new("ShaderNodeAttribute")
    at.attribute_name = "reg"
    n3 = N.noise(o, 34, 5)
    mx = N.math("MULTIPLY_ADD", n3.outputs["Fac"], 0.55, at.outputs["Fac"])
    rp = N.ramp(mx, [(0.6, 0.0), (0.72, 1.0)])
    mix = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(rp, mix.inputs[0])
    nt.links.new(r.outputs[0], mix.inputs[1])
    nt.links.new(s.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], nt.nodes["Material Output"].inputs[0])
    return m


def mat_hull(name, base, rough=0.4, sc=2.6, coat=0.2, line=0.25, grime=0.3, zs=1.5):
    """Painted panels with fine seams, one plate lighter than the next, some handling grime."""
    m, nt, N, p = new_mat(name)
    o = N.tc.outputs["Object"]
    mp = N.mapping(o, scale=(1, 1, zs))
    v = N.voronoi(mp, sc, "DISTANCE_TO_EDGE", 0.0)
    v2 = N.voronoi(mp, sc * 3.0, "DISTANCE_TO_EDGE", 0.0)
    plate = N.voronoi(mp, sc, "F1", 0.0)
    sep = nt.nodes.new("ShaderNodeSeparateColor")
    nt.links.new(plate.outputs["Color"], sep.inputs[0])
    tint = N.maprange(sep.outputs[0], 0, 1, 0.86, 1.04)
    lines = N.ramp(v.outputs["Distance"], [(0.008, line), (0.02, 1.0)])
    gate = N.ramp(sep.outputs[1], [(0.45, 0.0), (0.5, 1.0)])
    lines2 = N.ramp(v2.outputs["Distance"], [(0.01, 0.55), (0.034, 1.0)])
    lines2b = N.mix(gate, 1.0, lines2)
    gr = N.noise(N.mapping(o, scale=(6, 6, 1.1)), 3.0, 8, 0.62)
    grr = N.ramp(gr.outputs["Fac"], [(0.36, 1.0 - grime), (0.64, 1.0)])
    c1 = N.mix(1.0, (*base, 1), lines, "MULTIPLY")
    c2 = N.mix(1.0, c1, lines2b, "MULTIPLY")
    c3 = N.mix(1.0, c2, grr, "MULTIPLY")
    c4 = N.mix(1.0, c3, tint, "MULTIPLY")
    N.put(p.inputs["Base Color"], c4)
    N.put(p.inputs["Roughness"], N.maprange(gr.outputs["Fac"], 0.35, 0.7, rough * 1.35, rough * 0.75))
    p.inputs["Coat Weight"].default_value = coat
    p.inputs["Coat Roughness"].default_value = 0.15
    h = N.math("MULTIPLY", lines, lines2b)
    nb = N.bump(h, 0.7, 0.008)
    nt.links.new(nb, p.inputs["Normal"])
    return m


def mat_foil(name, base=(1.0, 0.6, 0.14), rough=0.2, metal=1.0, big=9.0, small=30.0, kink=0.55, wrinkle=0.6):
    """Crumpled insulation foil: facets at two scales pushing the normal around, so the hard sun breaks up on it."""
    m, nt, N, p = new_mat(name)
    o = N.tc.outputs["Object"]
    wob = N.noise(o, 4.0, 3)
    warped = N.vec("ADD", o, N.vec("SCALE", wob.outputs["Color"], scale=0.14))
    v1 = N.voronoi(warped, big)
    v2 = N.voronoi(warped, small)
    a = N.vec("SUBTRACT", v1.outputs["Color"], (0.5, 0.5, 0.5))
    b = N.vec("SUBTRACT", v2.outputs["Color"], (0.5, 0.5, 0.5))
    off = N.vec("ADD", N.vec("SCALE", a, scale=kink), N.vec("SCALE", b, scale=kink * 0.55))
    nrm = N.vec("NORMALIZE", N.vec("ADD", N.geo.outputs["Normal"], off))
    soft = N.noise(N.mapping(o, scale=(1.6, 1.6, 0.8)), 7.0, 5, 0.6)
    nb = nt.nodes.new("ShaderNodeBump")
    nb.inputs["Strength"].default_value = wrinkle
    nb.inputs["Distance"].default_value = 0.03
    nt.links.new(soft.outputs["Fac"], nb.inputs["Height"])
    nt.links.new(nrm, nb.inputs["Normal"])
    nt.links.new(nb.outputs["Normal"], p.inputs["Normal"])
    sep = nt.nodes.new("ShaderNodeSeparateColor")
    nt.links.new(v1.outputs["Color"], sep.inputs[0])
    tone = N.maprange(sep.outputs[0], 0, 1, 0.72, 1.06)
    N.put(p.inputs["Base Color"], N.mix(1.0, (*base, 1), tone, "MULTIPLY"))
    p.inputs["Metallic"].default_value = metal
    p.inputs["Roughness"].default_value = rough
    return m



# ---------- real spacecraft skins ----------
# Every surface is laid out in the coordinates of the structure it belongs to, so seams run along the hull instead of across the world.
def _rz(a):
    return np.array(((math.cos(a), -math.sin(a), 0.0), (math.sin(a), math.cos(a), 0.0), (0.0, 0.0, 1.0)))


def _euler(R):
    return tuple(Matrix(np.asarray(R).T.tolist()).to_euler("XYZ"))


def _xyz(N, v):
    n = N.nt.nodes.new("ShaderNodeSeparateXYZ")
    N.nt.links.new(v, n.inputs[0])
    return n.outputs[0], n.outputs[1], n.outputs[2]


def _combine(N, u, v):
    n = N.nt.nodes.new("ShaderNodeCombineXYZ")
    N.put(n.inputs[0], u)
    N.put(n.inputs[1], v)
    return n.outputs[0]


def uv_flat(R=SP_R):
    """Boxes and decks: each face takes the two axes lying in it, long side along the structure."""
    def build(N, o):
        x, y, z = _xyz(N, N.mapping(o, rot=_euler(R)))
        rn = N.nt.nodes.new("ShaderNodeMapping")
        rn.vector_type = "VECTOR"
        rn.inputs["Rotation"].default_value = _euler(R)
        N.nt.links.new(N.geo.outputs["True Normal"], rn.inputs["Vector"])
        nx, ny, _ = _xyz(N, rn.outputs[0])
        fx = N.math("GREATER_THAN", N.math("ABSOLUTE", nx), 0.6)
        fy = N.math("GREATER_THAN", N.math("ABSOLUTE", ny), 0.6)
        q = N.mix(fy, _combine(N, y, x), _combine(N, x, z))
        return N.mix(fx, q, _combine(N, y, z))
    return build


def uv_tube(rad, c=(0.0, 0.0, 0.0), R=SP_R, mirror=False):
    """A cylinder round the frame's y axis: plates run along it and wrap round it."""
    def build(N, o):
        x, y, z = _xyz(N, N.mapping(o, rot=_euler(R)))
        if mirror:
            x = N.math("ABSOLUTE", x)
        a = N.math("ARCTAN2", N.math("SUBTRACT", z, c[2]), N.math("SUBTRACT", x, c[0]))
        return _combine(N, y, N.math("MULTIPLY", a, rad))
    return build


def uv_ring(major, minor, c, R=SP_R):
    """A torus round the frame's y axis: plates follow the ring and wrap its section."""
    def build(N, o):
        x, y, z = _xyz(N, N.mapping(o, rot=_euler(R)))
        x_, y_, z_ = N.math("SUBTRACT", x, c[0]), N.math("SUBTRACT", y, c[1]), N.math("SUBTRACT", z, c[2])
        phi = N.math("ARCTAN2", z_, x_)
        rho = N.math("SQRT", N.math("ADD", N.math("MULTIPLY", x_, x_), N.math("MULTIPLY", z_, z_)))
        psi = N.math("ARCTAN2", y_, N.math("SUBTRACT", rho, major))
        return _combine(N, N.math("MULTIPLY", phi, major), N.math("MULTIPLY", psi, minor))
    return build


def _brick(N, vec, w, h, mortar, smooth=0.25, off=0.5, freq=2):
    n = N.nt.nodes.new("ShaderNodeTexBrick")
    n.offset, n.offset_frequency, n.squash, n.squash_frequency = off, freq, 1.0, 2
    for k, v in (("Color1", (0, 0, 0, 1)), ("Color2", (1, 1, 1, 1)), ("Mortar", (0, 0, 0, 1))):
        n.inputs[k].default_value = v
    for k, v in (("Scale", 1.0), ("Mortar Size", mortar), ("Mortar Smooth", smooth), ("Bias", 0.0), ("Brick Width", w), ("Row Height", h)):
        n.inputs[k].default_value = v
    N.nt.links.new(vec, n.inputs["Vector"])
    return n


def mat_skin(name, base, uv, w=1.2, h=0.7, rough=0.46, metal=0.0, wear=0.7, grime=0.2, odd=0.1, seam=0.01, rivets=True, marks=True):
    """Painted or anodised plates: thin dark seams, rivet lines beside them, small stencil marks, handling grime,
    and bare aluminium showing where edges and seams have been knocked. Most of what reads as scale lives here."""
    m, nt, N, p = new_mat(name)
    vec = uv(N, N.tc.outputs["Object"])
    plates = _brick(N, vec, w, h, seam)
    seam_f = plates.outputs["Fac"]
    band = _brick(N, vec, w, h, seam * 4.5, smooth=0.0).outputs["Fac"]
    sep = nt.nodes.new("ShaderNodeSeparateColor")
    nt.links.new(plates.outputs["Color"], sep.inputs[0])
    rnd = sep.outputs[0]
    col = N.mix(N.ramp(rnd, [(0.995 - odd, 0.0), (1.0 - odd, 1.0)]), base, tuple(v * 0.66 for v in base))
    col = N.mix(1.0, col, N.maprange(rnd, 0, 1, 0.87, 1.03), "MULTIPLY")
    gn = N.noise(N.mapping(vec, scale=(0.35, 6.0, 1.0)), 1.0, 6.0, 0.6)
    col = N.mix(1.0, col, N.ramp(gn.outputs["Fac"], [(0.36, 1.0 - grime), (0.66, 1.0)]), "MULTIPLY")
    u, v, _ = _xyz(N, vec)
    if marks:
        mk = N.math("MULTIPLY", N.math("LESS_THAN", N.math("FRACT", N.math("DIVIDE", u, 2.6)), 0.075), N.math("LESS_THAN", N.math("FRACT", N.math("DIVIDE", N.math("ADD", v, 0.13), 1.45)), 0.05))
        mk = N.math("MULTIPLY", mk, N.math("GREATER_THAN", rnd, 0.42))
        col = N.mix(N.math("MULTIPLY", mk, 0.85), col, (0.03, 0.03, 0.035))
    ao = nt.nodes.new("ShaderNodeAmbientOcclusion")
    ao.inside, ao.only_local, ao.samples = True, True, 4
    ao.inputs["Distance"].default_value = 0.045
    chip = N.noise(vec, 9.0, 6.0, 0.62)
    edge = N.math("MULTIPLY", N.math("SUBTRACT", 1.0, ao.outputs["AO"]), N.maprange(chip.outputs["Fac"], 0.35, 0.65, 0.35, 1.6))
    edge_w = N.maprange(edge, 0.16, 0.34, 0.0, 1.0)
    seam_w = N.math("MULTIPLY", band, N.ramp(N.noise(vec, 22.0, 4.0, 0.6).outputs["Fac"], [(0.55, 0.0), (0.61, 1.0)]))
    worn = N.math("MULTIPLY", N.math("MAXIMUM", edge_w, seam_w), wear, clamp=True)
    col = N.mix(worn, col, (0.6, 0.61, 0.63))
    col = N.mix(seam_f, col, (0.018, 0.018, 0.022))
    height = N.math("MULTIPLY", N.math("SUBTRACT", 1.0, seam_f), 1.0)
    if rivets:
        du = N.math("LESS_THAN", N.math("FRACT", N.math("DIVIDE", u, 0.14)), 0.34)
        dv = N.math("LESS_THAN", N.math("FRACT", N.math("DIVIDE", v, 0.14)), 0.34)
        dots = N.math("MULTIPLY", N.math("MULTIPLY", du, dv), N.math("MULTIPLY", band, N.math("SUBTRACT", 1.0, seam_f)))
        col = N.mix(N.math("MULTIPLY", dots, 0.55), col, (0.24, 0.24, 0.25))
        height = N.math("ADD", height, N.math("MULTIPLY", dots, 0.5))
    N.put(p.inputs["Base Color"], col)
    N.put(p.inputs["Metallic"], N.maprange(worn, 0.0, 1.0, metal, 1.0))
    ro = N.maprange(gn.outputs["Fac"], 0.35, 0.7, rough * 1.16, rough * 0.86)
    N.put(p.inputs["Roughness"], N.mix(worn, ro, 0.33))
    can = N.noise(vec, 2.4, 2.0, 0.4)
    height = N.math("ADD", height, N.math("MULTIPLY", can.outputs["Fac"], 0.6))
    nt.links.new(N.bump(height, 0.75, 0.012), p.inputs["Normal"])
    return m


def mat_blanket(name, base, uv, w=0.62, h=0.62, rough=0.74):
    """Beta cloth over insulation: a dull woven white, stitched into shallow pillows. No shine and no gold."""
    m, nt, N, p = new_mat(name)
    vec = uv(N, N.tc.outputs["Object"])
    st = _brick(N, vec, w, h, 0.012, off=0.0)
    pillow = _brick(N, vec, w, h, 0.11, smooth=1.0, off=0.0).outputs["Fac"]
    sep = nt.nodes.new("ShaderNodeSeparateColor")
    nt.links.new(st.outputs["Color"], sep.inputs[0])
    col = N.mix(1.0, base, N.maprange(sep.outputs[0], 0, 1, 0.92, 1.02), "MULTIPLY")
    gn = N.noise(N.mapping(vec, scale=(0.5, 3.0, 1.0)), 1.0, 5.0, 0.6)
    col = N.mix(1.0, col, N.ramp(gn.outputs["Fac"], [(0.36, 0.84), (0.66, 1.0)]), "MULTIPLY")
    col = N.mix(st.outputs["Fac"], col, (0.09, 0.09, 0.09))
    N.put(p.inputs["Base Color"], col)
    p.inputs["Roughness"].default_value = rough
    weave = N.noise(vec, 70.0, 2.0, 0.5)
    h_ = N.math("ADD", N.math("SUBTRACT", 1.0, pillow), N.math("MULTIPLY", weave.outputs["Fac"], 0.1))
    nt.links.new(N.bump(h_, 0.7, 0.03), p.inputs["Normal"])
    return m


def mat_film(name, base, uv, w=0.8, h=0.5, rough=0.33):
    """Metal film taped in strips: fine even crinkle and a soft wrinkle. The tone stays nearly flat, because big tonal patches are what read as toy foil."""
    m, nt, N, p = new_mat(name)
    vec = uv(N, N.tc.outputs["Object"])
    tape = _brick(N, vec, w, h, 0.016)
    col = N.mix(1.0, base, N.maprange(N.noise(vec, 1.6, 3.0, 0.5).outputs["Fac"], 0.3, 0.7, 0.92, 1.04), "MULTIPLY")
    col = N.mix(tape.outputs["Fac"], col, tuple(v * 0.55 + 0.06 for v in base))
    N.put(p.inputs["Base Color"], col)
    p.inputs["Metallic"].default_value = 1.0
    p.inputs["Roughness"].default_value = rough
    h_ = N.math("ADD", N.math("MULTIPLY", N.noise(vec, 46.0, 4.0, 0.55).outputs["Fac"], 0.3), N.noise(N.mapping(vec, scale=(0.8, 2.4, 1.0)), 5.0, 3.0, 0.5).outputs["Fac"])
    nt.links.new(N.bump(h_, 0.22, 0.016), p.inputs["Normal"])
    return m


def mat_trail(name, color, strength=5.0, edge=1.5):
    """Additive light for the launch trail: bright along the view axis of the tube, fading by a painted attribute."""
    m, nt, N, p = new_mat(name)
    nt.nodes.remove(p)
    em = nt.nodes.new("ShaderNodeEmission")
    em.inputs["Color"].default_value = (*color, 1)
    tr = nt.nodes.new("ShaderNodeBsdfTransparent")
    add = nt.nodes.new("ShaderNodeAddShader")
    at = nt.nodes.new("ShaderNodeAttribute")
    at.attribute_name = "fade"
    nv = N.math("ABSOLUTE", N.vec("DOT_PRODUCT", N.geo.outputs["Normal"], N.geo.outputs["Incoming"]))
    soft = N.math("POWER", nv, edge)
    st = N.math("MULTIPLY", N.math("MULTIPLY", at.outputs["Fac"], soft), strength)
    nt.links.new(st, em.inputs["Strength"])
    nt.links.new(tr.outputs[0], add.inputs[0])
    nt.links.new(em.outputs[0], add.inputs[1])
    nt.links.new(add.outputs[0], nt.nodes["Material Output"].inputs[0])
    m.cycles.emission_sampling = "NONE"
    return m


def mat_planet():
    m, nt, N, p = new_mat("planet")
    nt.nodes.remove(p)
    em = nt.nodes.new("ShaderNodeEmission")
    o = N.tc.outputs["Object"]
    Nrm, I = N.geo.outputs["Normal"], N.geo.outputs["Incoming"]
    warp = N.noise(o, 3.2, 4)
    w1 = N.vec("ADD", o, N.vec("SCALE", N.vec("SUBTRACT", warp.outputs["Color"], (0.5, 0.5, 0.5)), scale=0.6))
    big = N.noise(w1, 6.4, 8, 0.56).outputs["Fac"]
    streets = N.noise(N.mapping(w1, scale=(1.0, 3.2, 3.2), rot=(0.3, 0.5, 0.2)), 17.0, 7, 0.6).outputs["Fac"]
    t = N.math("ADD", N.math("MULTIPLY", big, 0.68), N.math("MULTIPLY", streets, 0.32))
    cloud = N.ramp(t, [(0.56, 0.0), (0.66, 0.34), (0.76, 0.6)])
    shal = N.noise(w1, 2.6, 5, 0.5).outputs["Fac"]
    ocean = N.ramp(shal, [(0.36, (0.006, 0.032, 0.16)), (0.56, (0.008, 0.075, 0.27)), (0.68, (0.018, 0.16, 0.34))])
    surf = N.mix(cloud, ocean, (0.46, 0.54, 0.68))
    s_ = N.vec("DOT_PRODUCT", Nrm, tuple(PLANET_SUN))
    lit = N.maprange(s_, 0.62, 1.0, 0.0, 0.8, smooth=True)
    day = N.mix(1.0, surf, lit, "MULTIPLY")
    night = (0.0012, 0.006, 0.026, 1)
    glow = N.mix(1.0, day, night, "ADD")
    nv = N.math("ABSOLUTE", N.vec("DOT_PRODUCT", Nrm, I))
    ray = N.math("POWER", N.math("SUBTRACT", 1.0, nv), 9.0)
    ray_l = N.math("MULTIPLY", ray, N.maprange(s_, -0.25, 0.5, 0.15, 1.0))
    out1 = N.mix(1.0, glow, N.mix(1.0, (0.1, 0.26, 0.7), ray_l, "MULTIPLY"), "ADD")
    gl = N.math("POWER", N.math("MAXIMUM", N.vec("DOT_PRODUCT", Nrm, tuple(PLANET_GLINT)), 0.0), 260.0)
    gl2 = N.math("MULTIPLY", gl, N.math("SUBTRACT", 1.0, N.math("MULTIPLY", cloud, 0.6)))
    out2 = N.mix(1.0, out1, N.mix(1.0, (0.95, 0.86, 0.68), N.math("MULTIPLY", gl2, 1.0), "MULTIPLY"), "ADD")
    nt.links.new(out2, em.inputs["Color"])
    em.inputs["Strength"].default_value = 1.0
    nt.links.new(em.outputs[0], nt.nodes["Material Output"].inputs[0])
    m.cycles.emission_sampling = "NONE"
    return m


def mat_atmos(shell):
    m, nt, N, p = new_mat("atmos")
    nt.nodes.remove(p)
    em = nt.nodes.new("ShaderNodeEmission")
    tr = nt.nodes.new("ShaderNodeBsdfTransparent")
    add = nt.nodes.new("ShaderNodeAddShader")
    Nrm, I = N.geo.outputs["Normal"], N.geo.outputs["Incoming"]
    c = N.vec("DOT_PRODUCT", Nrm, I)
    h = N.math("MULTIPLY", N.math("SQRT", N.math("MAXIMUM", N.math("SUBTRACT", 1.0, N.math("MULTIPLY", c, c)), 0.0)), shell)
    f = N.maprange(h, 0.9, shell, 0.0, 1.0)
    span = shell - 0.9

    def pos(hv):
        return (hv - 0.9) / span

    band = N.ramp(f, [
        (pos(0.9), (0, 0, 0)),
        (pos(0.982), (0.004, 0.016, 0.05)),
        (pos(0.994), (0.02, 0.08, 0.24)),
        (pos(0.9985), (0.12, 0.34, 0.85)),
        (pos(1.0003), (0.82, 0.92, 1.0)),
        (pos(1.0012), (0.3, 0.56, 1.0)),
        (pos(1.0035), (0.06, 0.2, 0.62)),
        (pos(1.009), (0.012, 0.05, 0.18)),
        (pos(1.022), (0.002, 0.009, 0.04)),
        (pos(shell - 0.001), (0, 0, 0)),
    ])
    s_ = N.vec("DOT_PRODUCT", Nrm, tuple(PLANET_SUN))
    lit = N.maprange(s_, -0.3, 0.55, 0.16, 1.0, smooth=True)
    a_ = N.mix(1.0, band, lit, "MULTIPLY")
    hot = N.math("POWER", N.math("MAXIMUM", N.vec("DOT_PRODUCT", Nrm, tuple(PLANET_HOT)), 0.0), 14.0)
    warm = N.ramp(f, [(pos(0.985), (0, 0, 0)), (pos(0.994), (1.0, 0.28, 0.04)), (pos(0.999), (1.0, 0.6, 0.2)), (pos(1.003), (0, 0, 0))])
    hb = N.mix(1.0, warm, hot, "MULTIPLY")
    a_c = N.mix(1.0, a_, N.mix(hot, (1, 1, 1), (1.0, 0.66, 0.34)), "MULTIPLY")
    tot = N.mix(1.0, a_c, N.mix(1.0, hb, (2.0, 2.0, 2.0), "MULTIPLY"), "ADD")
    nt.links.new(tot, em.inputs["Color"])
    # only the near side of the shell glows, or the sky gets it twice and the limb shows a step
    nt.links.new(N.math("MULTIPLY", 2.5, N.math("SUBTRACT", 1.0, N.geo.outputs["Backfacing"])), em.inputs["Strength"])
    nt.links.new(tr.outputs[0], add.inputs[0])
    nt.links.new(em.outputs[0], add.inputs[1])
    nt.links.new(add.outputs[0], nt.nodes["Material Output"].inputs[0])
    m.cycles.emission_sampling = "NONE"
    return m



# where the planet sits is decided from the camera: a thin limb, low in the frame, rising towards the low end of the spine
_v = (TG - CP).normalized()
_r = _v.cross(Vector((0, 0, 1))).normalized()
_u = _r.cross(_v).normalized()
P_ALPHA = math.radians(58.0)                 # angular radius of the planet seen from the camera
P_BETA = P_ALPHA + math.radians(8.3)         # limb sits well below the middle of the frame
P_TILT = math.radians(-6.0)                 # the limb leans, rising towards the low end of the spine
P_D = 6.0 * LAY["dist"]
P_R = P_D * math.sin(P_ALPHA)
_pd = (_v * math.cos(P_BETA) + (-_u * math.cos(P_TILT) + _r * math.sin(P_TILT)) * math.sin(P_BETA)).normalized()
P_C = CP + _pd * P_D
_limb_up = (_v * math.sin(P_BETA) * -1.0 + (_u * math.cos(P_TILT) - _r * math.sin(P_TILT)) * math.cos(P_BETA)).normalized()
PLANET_SUN = (SUN_DIR * 0.42 + _limb_up * 0.86 + _r * 0.1).normalized()
PLANET_HOT = (_limb_up + _r * 0.55).normalized()
PLANET_GLINT = (_limb_up * 0.86 - _v * 0.42 + _r * 0.42).normalized()


WHITE = (0.8, 0.81, 0.8)
GREY = (0.4, 0.41, 0.43)
BLANKET = (0.6, 0.6, 0.585)
KAPTON = (0.66, 0.42, 0.12)
FILM = (0.6, 0.61, 0.63)
RING_C = (0.0, 31.0, 1.28)
BAY_R = SP_R @ _rz(math.radians(68.0))
BAY_C = tuple(_rz(math.radians(-68.0)) @ np.array((0.15, -1.15, 1.02)))
MATS = dict(
    reg=mat_regolith(), rock=mat_rock(),
    planet=mat_planet(), atmos=mat_atmos(1.032),
    hull=mat_skin("hull", WHITE, uv_flat(), 1.15, 0.72),
    hull2=mat_skin("hull2", GREY, uv_flat(), 0.95, 0.6, rough=0.36, metal=1.0, wear=0.5, odd=0.16),
    hulld=mat_skin("hulld", (0.06, 0.065, 0.075), uv_flat(), 0.8, 0.5, rough=0.38, metal=1.0, wear=0.3, marks=False),
    deck=mat_skin("deck", (0.085, 0.09, 0.1), uv_flat(), 1.3, 0.85, rough=0.62, metal=0.2, wear=0.45, grime=0.4, marks=False),
    sp_w=mat_skin("sp_w", WHITE, uv_tube(0.95), 1.7, 0.62),
    sp_g=mat_skin("sp_g", GREY, uv_tube(0.95), 1.25, 0.5, rough=0.36, metal=1.0, wear=0.5, odd=0.16),
    ring_w=mat_skin("ring_w", WHITE, uv_ring(4.7, 0.72, RING_C), 1.5, 0.56),
    bay_w=mat_skin("bay_w", WHITE, uv_tube(2.5, BAY_C, BAY_R), 1.2, 0.62),
    drum_w=mat_skin("drum_w", WHITE, uv_tube(0.62, (1.72, 0.0, -0.82), mirror=True), 1.3, 0.5),
    mli=mat_blanket("mli", BLANKET, uv_tube(0.95)),
    mli_f=mat_blanket("mli_f", BLANKET, uv_flat()),
    mli_r=mat_blanket("mli_r", BLANKET, uv_ring(4.7, 0.72, RING_C)),
    bay_b=mat_blanket("bay_b", BLANKET, uv_tube(2.5, BAY_C, BAY_R)),
    drum_b=mat_blanket("drum_b", BLANKET, uv_tube(0.62, (1.72, 0.0, -0.82), mirror=True)),
    gold=mat_film("gold", KAPTON, uv_flat()),
    gold2=mat_film("gold2", tuple(v * 0.9 for v in KAPTON), uv_flat()),
    gold_t=mat_film("gold_t", KAPTON, uv_tube(0.95)),
    gold_r=mat_film("gold_r", KAPTON, uv_ring(4.7, 0.72, RING_C)),
    silver=mat_film("silver", FILM, uv_tube(0.95)),
    silver_f=mat_film("silver_f", FILM, uv_flat()),
    silver_r=mat_film("silver_r", FILM, uv_ring(4.7, 0.72, RING_C)),
    brass=pbsdf("brass", (0.62, 0.44, 0.24), 0.36, metal=1.0),
    steel=pbsdf("steel", (0.46, 0.47, 0.5), 0.34, metal=1.0),
    haz=pbsdf("haz", (0.92, 0.5, 0.025), 0.45, coat=0.2),
    roller=pbsdf("roller", (0.13, 0.135, 0.15), 0.42, metal=0.8),
    rail=pbsdf("rail", (0.05, 0.052, 0.06), 0.5, metal=0.7),
    grid=pbsdf("grid", (0.62, 0.62, 0.6), 0.32, metal=1.0),
    cell_a=pbsdf("cell_a", (0.011, 0.038, 0.14), 0.3, metal=0.1, coat=0.35),
    cell_b=pbsdf("cell_b", (0.014, 0.05, 0.18), 0.34, metal=0.1, coat=0.35),
    cell_c=pbsdf("cell_c", (0.008, 0.026, 0.1), 0.26, metal=0.1, coat=0.35),
    glass=pbsdf("glass", (0.012, 0.016, 0.024), 0.08, coat=1.0),
    window=pbsdf("window", (0, 0, 0), 0.2, emis=(1.0, 0.46, 0.13), emis_str=3.4),
    winw=pbsdf("winw", (0, 0, 0), 0.2, emis=(1.0, 0.82, 0.62), emis_str=3.2),
    lamp=pbsdf("lamp", (0, 0, 0), 0.3, emis=(1.0, 0.62, 0.26), emis_str=11),
    beacon=pbsdf("beacon", (0, 0, 0), 0.3, emis=(1.0, 0.07, 0.04), emis_str=11),
    star=pbsdf("star", (0, 0, 0), 0.3, emis=(0.76, 0.86, 1.0), emis_str=30),
    thrust=pbsdf("thrust", (0, 0, 0), 0.3, emis=(0.36, 0.72, 1.0), emis_str=14),
    crate=pbsdf("crate", (0.46, 0.48, 0.5), 0.42),
    label=pbsdf("label", (0.09, 0.14, 0.26), 0.4),
    crate2=pbsdf("crate2", (0.2, 0.22, 0.25), 0.5),
    crate3=pbsdf("crate3", (0.62, 0.3, 0.07), 0.46),
    rubber=pbsdf("rubber", (0.012, 0.012, 0.014), 0.72),
    dent=pbsdf("dent", (0.09, 0.08, 0.07), 0.95),
    eye=pbsdf("eye", mascots.EYE_MATERIAL["base"], mascots.EYE_MATERIAL["roughness"], coat=mascots.EYE_MATERIAL["coat"], coat_rough=mascots.EYE_MATERIAL["coat_roughness"]),
    leaf=pbsdf("leaf", (0.05, 0.3, 0.06), 0.6, emis=(0.25, 0.9, 0.2), emis_str=0.4),
    orb=pbsdf("orb", (0, 0, 0), 0.2, emis=(1.0, 0.55, 0.16), emis_str=12),
)


# ---------- geometry ----------
class Geo:
    def __init__(self):
        self.d = {}
        self.skip = False
        self.xf = None

    def add(self, mat, V, F, S):
        if self.skip:
            return
        if self.xf is not None:
            R_, p_, k_ = self.xf
            V = (np.asarray(V, dtype=np.float64) * k_) @ R_.T + p_
        mat = CUR.get(mat, mat)
        e = self.d.setdefault(mat, dict(v=[], f=[], s=[], n=0))
        e["v"].append(np.asarray(V, dtype=np.float64))
        n = e["n"]
        e["f"].extend([tuple(i + n for i in f) for f in F])
        e["s"].extend(S)
        e["n"] = n + len(V)

    def build(self):
        for mat, e in self.d.items():
            V = np.concatenate(e["v"])
            me = bpy.data.meshes.new(mat)
            me.from_pydata(V.tolist(), [], e["f"])
            me.polygons.foreach_set("use_smooth", e["s"])
            me.update()
            me.materials.append(MATS[mat])
            bpy.context.collection.objects.link(bpy.data.objects.new(mat, me))
        self.d = {}


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


def lathe(mat, c, prof, seg=28, rx=0.0, rz=0.0, smooth=True):
    V, F = [], []
    for r, z in prof:
        for i in range(seg):
            t = 2 * math.pi * i / seg
            V.append((r * math.cos(t), r * math.sin(t), z))
    for j in range(len(prof) - 1):
        for i in range(seg):
            a, b = j * seg + i, j * seg + (i + 1) % seg
            F.append((a, b, b + seg, a + seg))
    G.add(mat, np.array(V) @ _rot(rz, rx).T + np.asarray(c), F, [smooth] * len(F))


def loft(mat, rings, closed=True, smooth=True, attr=None):
    rings = np.asarray(rings, float)
    k, m_ = rings.shape[0], rings.shape[1]
    V = rings.reshape(-1, 3)
    F = []
    for j in range(k - 1):
        for i in range(m_ if closed else m_ - 1):
            a, b = j * m_ + i, j * m_ + (i + 1) % m_
            F.append((a, b, b + m_, a + m_))
    G.add(mat, V, F, [smooth] * len(F))


def prism(mat, c, R, h, n=8, rz=0.0, top=None):
    top = R if top is None else top
    a = [rz + 2 * math.pi * i / n for i in range(n)]
    V = [(R * math.cos(t), R * math.sin(t), 0.0) for t in a] + [(top * math.cos(t), top * math.sin(t), h) for t in a]
    F = [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)] + [tuple(range(n, 2 * n)), tuple(range(n - 1, -1, -1))]
    G.add(mat, np.array(V) + np.asarray(c), F, [False] * len(F))


def torus(mat, c, R, r, M=None, a0=0.0, a1=2 * math.pi, nu=64, nv=12, zs=1.0, offs=0.0):
    full = abs(a1 - a0 - 2 * math.pi) < 1e-6
    us = np.linspace(a0, a1, nu, endpoint=not full)
    vs = np.linspace(0, 2 * np.pi, nv, endpoint=False)
    rr = R + offs + r * np.cos(vs)
    zz = r * np.sin(vs) * zs
    V = np.zeros((len(us) * nv, 3))
    for j, u in enumerate(us):
        V[j * nv:(j + 1) * nv, 0] = rr * math.cos(u)
        V[j * nv:(j + 1) * nv, 1] = rr * math.sin(u)
        V[j * nv:(j + 1) * nv, 2] = zz
    F = []
    for j in range(len(us) if full else len(us) - 1):
        j2 = (j + 1) % len(us)
        for i in range(nv):
            i2 = (i + 1) % nv
            F.append((j * nv + i, j2 * nv + i, j2 * nv + i2, j * nv + i2))
    if M is not None:
        V = V @ M.T
    G.add(mat, V + np.asarray(c), F, [True] * len(F))


def quad(mat, a, b, c, d):
    G.add(mat, np.array((a, b, c, d), float), [(0, 1, 2, 3)], [False])


def perp(d):
    d = np.asarray(d, float)
    d = d / (np.linalg.norm(d) + 1e-9)
    u = np.cross(d, (0, 0, 1) if abs(d[2]) < 0.9 else (1, 0, 0))
    u /= np.linalg.norm(u)
    return d, u, np.cross(d, u)


def truss(a, b, w, n, mat="rail", rc=0.012, rd=0.005, corners=3, phase=0.4):
    """A lattice beam between two points, three or four chords, braced."""
    a, b = np.asarray(a, float), np.asarray(b, float)
    d, u, v = perp(b - a)
    offs = [(u * math.cos(phase + 2 * math.pi * k / corners) + v * math.sin(phase + 2 * math.pi * k / corners)) * w for k in range(corners)]
    pts = [[a + (b - a) * (i / n) + o for o in offs] for i in range(n + 1)]
    for k in range(corners):
        cyl(mat, pts[0][k], pts[n][k], rc, seg=6, cap=False)
    for i in range(n):
        for k in range(corners):
            cyl(mat, pts[i][k], pts[i + 1][(k + 1) % corners], rd, seg=4, cap=False)
            cyl(mat, pts[i + 1][k], pts[i + 1][(k + 1) % corners], rd, seg=4, cap=False)


def ring_windows(c, r, n, w, h, skip=0, mats=("window",)):
    """Lit windows around a drum, one in `skip` left dark."""
    for i in range(n):
        a = 2 * math.pi * i / n
        if skip and i % skip == 0:
            m_ = "glass"
        else:
            m_ = mats[i % len(mats)]
        box(m_, (c[0] + math.cos(a) * (r + 0.004), c[1] + math.sin(a) * (r + 0.004), c[2]), (0.012, w, h), r=0.0, rz=a)


def solar_wing(c, u, v, nu, nv, spar="gold", edge=0.018):
    """A blanket array: dark cells with gold grid lines and a bright frame, the real thing in small."""
    c, u, v = np.asarray(c, float), np.asarray(u, float), np.asarray(v, float)
    n = np.cross(u, v)
    n /= np.linalg.norm(n)
    if n[2] < 0:
        n = -n
    for i in range(nu):
        for j in range(nv):
            x0, x1 = -1 + 2 * i / nu, -1 + 2 * (i + 1) / nu
            y0, y1 = -1 + 2 * j / nv, -1 + 2 * (j + 1) / nv
            m_ = random.choice(("cell_a", "cell_a", "cell_b", "cell_c"))
            quad(m_, c + u * x0 + v * y0, c + u * x1 + v * y0, c + u * x1 + v * y1, c + u * x0 + v * y1)
    lu, lv = np.linalg.norm(u), np.linalg.norm(v)
    wu = 0.0048 / lu
    wv = 0.0048 / lv
    o = n * 0.003
    for i in range(nu + 1):
        x = -1 + 2 * i / nu
        k = 2.4 if i % 4 == 0 else 1.0
        quad("grid", c + o + u * (x - wu * k) - v, c + o + u * (x + wu * k) - v, c + o + u * (x + wu * k) + v, c + o + u * (x - wu * k) + v)
    for j in range(nv + 1):
        y = -1 + 2 * j / nv
        k = 2.4 if j % 4 == 0 else 1.0
        quad("grid", c + o - u + v * (y - wv * k), c + o + u + v * (y - wv * k), c + o + u + v * (y + wv * k), c + o - u + v * (y + wv * k))
    p = [c - u - v, c + u - v, c + u + v, c - u + v]
    for a, b in zip(p, p[1:] + p[:1]):
        cyl(spar, a, b, edge, seg=6)



# ---------- the bots: the body shapes from the brand art ----------
def bot(c, s, shape="squircle", facing=math.radians(18), pitch=-7.0):
    m = mascots.placed_mesh(shape, size=s, base=(c[0], c[1], c[2] - 0.47 * s), facing=facing, pitch=math.radians(pitch))
    G.add("bot", m["body_v"], m["body_f"], [True] * len(m["body_f"]))
    G.add("eye", m["eye_v"], m["eye_f"], [True] * len(m["eye_f"]))


def bot_mats(key, col, state, s=1.0):
    m_ = max(col)
    c_ = tuple((x / m_) ** 1.7 for x in col)
    hot = tuple(x * 0.88 + 0.12 for x in c_)
    k = dict(idle=0.55, working=1.0, found=1.2, done=0.85, main=1.0)[state]
    names = dict(led_on=f"led_on_{key}", led_dim=f"led_dim_{key}", led_hot=f"led_hot_{key}", bot=f"bot_{key}", dome=f"dome_{key}", led_off="rail")
    MATS[names["led_on"]] = pbsdf(names["led_on"], (0, 0, 0), 0.4, emis=c_, emis_str=3.1 * k)
    MATS[names["led_dim"]] = pbsdf(names["led_dim"], (0, 0, 0), 0.4, emis=c_, emis_str=1.2 * k)
    MATS[names["led_hot"]] = pbsdf(names["led_hot"], (0, 0, 0), 0.4, emis=hot, emis_str=5.5 * k)
    MATS[names["bot"]] = pbsdf(names["bot"], col, mascots.GLOSSY["roughness"], coat=mascots.GLOSSY["coat"], coat_rough=mascots.GLOSSY["coat_roughness"], sss=mascots.GLOSSY["sss"], sss_scale=mascots.GLOSSY["sss_scale"] * s)
    MATS[names["dome"]] = pbsdf(names["dome"], tuple(0.16 * v + 0.05 for v in c_), 0.1, emis=tuple(0.8 * v + 0.2 for v in c_), emis_str=0.34 * k, coat=1.0)
    return names, c_


def point(p, e, col=(1.0, 0.62, 0.3), r=0.03):
    if G.skip:
        return
    l = bpy.data.lights.new("pt", "POINT")
    l.energy = e
    l.color = col
    l.shadow_soft_size = r
    o = bpy.data.objects.new("pt", l)
    o.location = p
    bpy.context.collection.objects.link(o)


# ---------- a small ship, nobody's real craft: a stubby tug with two pods ----------
def ship(c, s=1.0, rz=0.0, legs=True, burn=False):
    c = np.asarray(c, float)
    R = _rot(rz)

    def W(p):
        return (np.asarray(p, float) * s) @ R.T + c

    st = [(-0.8, 0.2, 0.17), (-0.74, 0.3, 0.25), (-0.22, 0.36, 0.3), (0.3, 0.33, 0.28), (0.62, 0.24, 0.21), (0.8, 0.12, 0.11), (0.87, 0.02, 0.02)]
    ts = np.linspace(0, 2 * np.pi, 28, endpoint=False)

    def sect(x, w, h):
        return [W((x, w * math.copysign(abs(math.cos(t)) ** 0.7, math.cos(t)), h * math.copysign(abs(math.sin(t)) ** 0.7, math.sin(t)))) for t in ts]

    loft("hull", [sect(*q) for q in st])
    # The live ship has a flat material, so its seams are real geometry: thin dark hoops and strips standing proud of the skin.
    _x, _w, _h = zip(*st)
    for xs in (-0.5, -0.3, -0.16, 0.14, 0.3, 0.46, 0.6):
        w_, h_ = float(np.interp(xs, _x, _w)), float(np.interp(xs, _x, _h))
        loft("hulld", [sect(xs - 0.0022, w_ + 0.0012, h_ + 0.0012), sect(xs + 0.0022, w_ + 0.0012, h_ + 0.0012)], smooth=False)
    for sgn in (-1, 1):
        for xs in (-0.3, -0.2, 0.2):
            # Lit windows only: dark ones read as specks on the hull.
            if xs > 0:
                box("winw", W((xs, sgn * 0.356, 0.13)), (0.05 * s, 0.006 * s, 0.03 * s), r=0.0, rz=rz)
    loft("led_on", [sect(-0.04, 0.368, 0.309), sect(0.04, 0.362, 0.306)])
    loft("rail", [sect(-0.64, 0.325, 0.272), sect(-0.6, 0.33, 0.276)])
    sphere("glass", W((0.42, 0, 0.13)), 0.27 * s, seg=20, rings=12, sc=(1.05, 0.72, 0.56))
    for sgn in (-1, 1):
        a, b = W((-0.86, sgn * 0.47, -0.02)), W((-0.2, sgn * 0.47, -0.02))
        cyl("hull2", a, b, 0.14 * s, seg=16)
        cyl("gold", W((-0.62, sgn * 0.47, -0.02)), W((-0.44, sgn * 0.47, -0.02)), 0.143 * s, seg=16)
        for xs in (-0.78, -0.3):
            cyl("hulld", W((xs - 0.003, sgn * 0.47, -0.02)), W((xs + 0.003, sgn * 0.47, -0.02)), 0.1425 * s, seg=16)
        cyl("hull", W((-0.26, sgn * 0.47, -0.02)), W((0.02, sgn * 0.47, -0.02)), 0.14 * s, seg=16, r2=0.06 * s)
        cyl("rail", W((-0.93, sgn * 0.47, -0.02)), a, 0.12 * s, seg=16, r2=0.14 * s)
        cyl("thrust" if burn else "led_hot", W((-0.935, sgn * 0.47, -0.02)), W((-0.93, sgn * 0.47, -0.02)), 0.095 * s, seg=14)
        cyl("hull", W((-0.42, sgn * 0.14, -0.02)), W((-0.42, sgn * 0.46, -0.02)), 0.05 * s, seg=8)
        if legs:
            a2 = W((0.16 if sgn > 0 else -0.46, sgn * 0.3, -0.18))
            b2 = W((0.16 if sgn > 0 else -0.46, sgn * 0.4, -0.42))
            cyl("steel", a2, b2, 0.016 * s, seg=6)
            cyl("rail", b2, b2 - np.array((0, 0, 0.018 * s)), 0.05 * s, seg=10)
    box("hull2", W((-0.44, 0, 0.34)), (0.34 * s, 0.05 * s, 0.22 * s), r=0.012, rz=rz, ry=0.0)
    box("hull2", W((0.05, 0, 0.3)), (0.32 * s, 0.26 * s, 0.03 * s), r=0.008, rz=rz)
    sphere("lamp", W((0.62, 0.14, 0.12)), 0.018 * s, seg=7, rings=4)
    sphere("beacon", W((-0.44, 0, 0.47)), 0.014 * s, seg=7, rings=4)
    if legs:
        cyl("steel", W((0.5, 0, -0.16)), W((0.56, 0, -0.42)), 0.016 * s, seg=6)
        cyl("rail", W((0.56, 0, -0.42)), W((0.56, 0, -0.438)), 0.05 * s, seg=10)



# ---------- a local frame for building: nested placing, lights and bots follow it ----------
@contextmanager
def place(p=(0, 0, 0), rz=0.0, k=1.0, R=None):
    old = G.xf
    Rn = _rot(rz) if R is None else R
    if old is None:
        G.xf = (Rn, np.asarray(p, float), k)
    else:
        Ro, po, ko = old
        G.xf = (Ro @ Rn, (np.asarray(p, float) * ko) @ Ro.T + po, ko * k)
    try:
        yield
    finally:
        G.xf = old


def L(q):
    q = np.asarray(q, float)
    if G.xf is None:
        return q
    R, p, k = G.xf
    return (q * k) @ R.T + p


SP_YAW = math.atan2(SP_R[1, 0], SP_R[0, 0])


def frame_yaw(rz=0.0):
    """Turn of a thing against the spine axes the live cargo was built in."""
    R = G.xf[0]
    return rz + math.atan2(R[1, 0], R[0, 0]) - SP_YAW


@contextmanager
def live(name=None, pivot=None):
    """PT.actor or PT.drop. Both open a fresh G with no frame, so the frame in force here is carried in by hand."""
    xf = G.xf
    with (PT.actor(name, pivot=pivot) if name else PT.drop()):
        G.xf = xf
        yield


def kicker(q, s, e=26.0):
    """A small hard lamp above the lens side of a bot: it draws one tight highlight on the glossy body."""
    if PT.ON:
        return
    R, p, k = G.xf
    cam = ((CP_np - p) @ R) / k
    d = (cam - np.asarray(q, float))
    d[2] = 0.0
    d /= np.linalg.norm(d)
    side = np.array((d[1], -d[0], 0.0))
    lpoint(np.asarray(q, float) + d * 1.3 * s + side * 0.9 * s + np.array((0, 0, 1.55 * s)), e * s * s, col=(1.0, 0.93, 0.85), r=0.05 * s)


def lpoint(q, e, col=(1.0, 0.62, 0.3), r=0.03):
    point(tuple(L(q)), e, col=col, r=r)


def worker(q, s, shape, work, mix=0.6, tool=None, key=None, **tool_kw):
    """A bot at its station: faces its work, turned towards the lens by `mix` so the eyes still read, tipped back so the face is not lost."""
    q = np.asarray(q, float)
    R, p, k = G.xf
    cam = ((CP_np - p) @ R) / k
    dc = (cam - q)[:2]
    dc /= np.linalg.norm(dc)
    dw = (np.asarray(work, float) - q)[:2]
    dw /= np.linalg.norm(dw)
    d = dw * (1.0 - mix) + dc * mix
    f = math.atan2(d[0], -d[1])
    el = math.degrees(math.atan2(cam[2] - q[2], math.hypot(*(cam - q)[:2])))
    tip = -0.72 * el * max(0.0, float(np.dot(d / np.linalg.norm(d), dc))) ** 2
    if PT.ON:
        PT.bot(key, L((q[0], q[1], q[2] - 0.47 * s)), s * k, yaw=f + math.atan2(R[1, 0], R[0, 0]), shape=shape, tool=tool)
    else:
        bot(tuple(q), s, shape, facing=f, pitch=tip)
    if tool:
        with live("tool_" + str(key), pivot=L(q)):
            for part in mascots.placed_prop(tool, shape=shape, size=s, base=(q[0], q[1], q[2] - 0.47 * s), facing=f, pitch=math.radians(tip), **tool_kw):
                G.add(part["mat"], part["v"], part["f"], [True] * len(part["f"]))


# ---------- the crew and the light of each stage of the line ----------
TEAM = dict(orange=((1.0, 0.36, 0.05), "squircle"), green=((0.08, 0.72, 0.36), "triangle"), pink=((1.0, 0.1, 0.42), "cloud"), main=((0.9, 0.91, 0.93), "sphere"), amber=((1.0, 0.52, 0.14), "sphere"))
_NM, _C = {}, {}
for _k, (_col, _sh) in TEAM.items():
    _NM[_k], _C[_k] = bot_mats(_k, _col, "main" if _k == "main" else "working", s=1.2)


def tint(key):
    """A coloured lamp baked into the plate could never change with the bot. The plate gets plain light, and the accent pass brings the colour."""
    return (1.0, 0.86, 0.72) if PT.ON else _C[key]


def tint_e(e):
    return e * 0.4 if PT.ON else e


def use(key):
    CUR.clear()
    CUR.update(_NM[key])


def mat_curtain(name, color, strength):
    m, nt, N, p = new_mat(name)
    nt.nodes.remove(p)
    em = nt.nodes.new("ShaderNodeEmission")
    em.inputs["Color"].default_value = (*color, 1)
    em.inputs["Strength"].default_value = strength
    tr = nt.nodes.new("ShaderNodeBsdfTransparent")
    add = nt.nodes.new("ShaderNodeAddShader")
    nt.links.new(tr.outputs[0], add.inputs[0])
    nt.links.new(em.outputs[0], add.inputs[1])
    nt.links.new(add.outputs[0], nt.nodes["Material Output"].inputs[0])
    m.cycles.emission_sampling = "NONE"
    return m


MATS.update(mascots.prop_materials(pbsdf, size=1.2))
MATS["curtain"] = mat_curtain("curtain", _C["green"], 0.34)
MATS["beam"] = mat_curtain("beam", _C["green"], 0.9)
MATS["shiptrail"] = mat_trail("shiptrail", (0.12, 0.42, 1.0), 1.9, 1.0)
_hot = (_C["amber"][0], _C["amber"][1] * 0.72, _C["amber"][2] * 0.3)
MATS["podh"] = pbsdf("podh", (0, 0, 0), 0.3, emis=_hot, emis_str=6.5)
for _nm, _st, _edge in (("lc", 3.0, 0.8), ("lm", 1.7, 1.3), ("lo", 0.7, 2.2)):
    MATS[_nm] = mat_trail(_nm, _hot, _st, _edge)

CLEARED = "led_on_green"


def thrust_trail(a, b, r=0.05):
    a, b = np.asarray(a, float), np.asarray(b, float)
    d, u, w = perp(b - a)
    ang = np.linspace(0, 2 * np.pi, 10, endpoint=False)
    n = 14
    rings, fades = [], []
    for t in np.linspace(0, 1, n):
        q = a + (b - a) * t
        r_ = r * (1 - t) + 0.006 * t
        rings.append([q + (u * math.cos(x) + w * math.sin(x)) * r_ for x in ang])
        fades.extend([(1 - t) ** 2.2] * 10)
    V = np.array(rings).reshape(-1, 3)
    F = [(j * 10 + i, j * 10 + (i + 1) % 10, (j + 1) * 10 + (i + 1) % 10, (j + 1) * 10 + i) for j in range(n - 1) for i in range(10)]
    me = bpy.data.meshes.new("shiptrail")
    me.from_pydata(V.tolist(), [], F)
    me.polygons.foreach_set("use_smooth", [True] * len(F))
    at = me.attributes.new("fade", "FLOAT", "POINT")
    at.data.foreach_set("value", np.array(fades, dtype=np.float32))
    me.update()
    me.materials.append(MATS["shiptrail"])
    bpy.context.collection.objects.link(bpy.data.objects.new("shiptrail", me))


def glow_tube(nm, path, r0, r1, fade_fn, n=60):
    ang = np.linspace(0, 2 * np.pi, 18, endpoint=False)
    rings, fades = [], []
    ts = np.linspace(0, 1, n)
    for t in ts:
        q = path(t)
        q2 = path(min(t + 0.01, 1.0)) if t < 1 else q + (q - path(t - 0.01))
        d, u, w = perp(q2 - q)
        r = r0 + (r1 - r0) * t
        rings.append([q + (u * math.cos(a) + w * math.sin(a)) * r for a in ang])
        fades.extend([fade_fn(t)] * 18)
    V = np.array(rings).reshape(-1, 3)
    F = [(j * 18 + i, j * 18 + (i + 1) % 18, (j + 1) * 18 + (i + 1) % 18, (j + 1) * 18 + i) for j in range(n - 1) for i in range(18)]
    me = bpy.data.meshes.new(nm)
    me.from_pydata(V.tolist(), [], F)
    me.polygons.foreach_set("use_smooth", [True] * len(F))
    at = me.attributes.new("fade", "FLOAT", "POINT")
    at.data.foreach_set("value", np.array(fades, dtype=np.float32))
    me.update()
    me.materials.append(MATS[nm])
    bpy.context.collection.objects.link(bpy.data.objects.new(nm, me))


# ---------- cargo ----------
def crate(c, s, mat="crate3", cleared=False, rz=0.0, skid=False):
    """A cargo box: ribbed walls, steel corners, dark frames, a small white stencil plate. A cleared crate carries the green band."""
    with place(c, rz=rz):
        box(mat, (0, 0, 0), (s * 0.95, s * 0.95, s * 0.95), r=s * 0.02)
        for sx in (-1, 1):
            for sy in (-1, 1):
                box("hull2", (sx * s * 0.46, sy * s * 0.46, 0), (s * 0.09, s * 0.09, s), r=s * 0.012)
        # A frame round each end, not a slab: the top of the box stays its own colour, as cargo does in the sun.
        for z_ in (-0.46, 0.46):
            for sg in (-1, 1):
                box("rail", (0, sg * s * 0.47, z_ * s), (s * 1.0, s * 0.06, s * 0.08), r=s * 0.008)
                box("rail", (sg * s * 0.47, 0, z_ * s), (s * 0.06, s * 1.0, s * 0.08), r=s * 0.008)
        for k in (-0.2, 0.2):
            for sg in (-1, 1):
                box("hull2", (k * s, sg * s * 0.48, 0), (s * 0.04, s * 0.012, s * 0.84), r=0.0)
                box("hull2", (sg * s * 0.48, k * s, 0), (s * 0.012, s * 0.04, s * 0.84), r=0.0)
        box("label", (-s * 0.16, -s * 0.497, s * 0.2), (s * 0.3, s * 0.012, s * 0.16), r=0.0)
        box("label", (s * 0.497, s * 0.16, s * 0.2), (s * 0.012, s * 0.3, s * 0.16), r=0.0)
        if cleared:
            box(CLEARED, (0, 0, -s * 0.2), (s * 1.03, s * 1.03, s * 0.085), r=0.0)
        if skid:
            # What it rides the rollers on, with the small marker lamps that give it its size.
            box("hulld", (0, 0, -s * 0.52), (s * 1.06, s * 1.06, s * 0.07), r=0.01)
            box("lamp", (s * 0.34, -s * 0.535, -s * 0.52), (0.05, 0.01, 0.03), r=0.0)
            box("beacon", (-s * 0.34, s * 0.535, -s * 0.52), (0.05, 0.01, 0.03), r=0.0)


def sled(t, x, z, s, mat="crate3", cleared=False, rz=0.0):
    """A low flat truck on the rollers with one crate on it."""
    with place((x, t, z), rz=rz):
        box("hulld", (0, 0, 0.09), (s * 1.16, s * 1.2, 0.1), r=0.02)
        box("steel", (0, 0, 0.15), (s * 1.0, s * 1.04, 0.02), r=0.0)
        for sx in (-1, 1):
            for sy in (-1, 1):
                cyl("rubber", (sx * s * 0.5, sy * s * 0.42, 0.06), (sx * s * 0.62, sy * s * 0.42, 0.06), 0.07, seg=10)
        box("lamp", (s * 0.34, -s * 0.61, 0.09), (0.05, 0.01, 0.03), r=0.0)
        box("beacon", (-s * 0.34, s * 0.61, 0.09), (0.05, 0.01, 0.03), r=0.0)
        crate((0, 0, 0.16 + s / 2), s, mat, cleared)


def roller_bed(a, b, w, step=0.46, z=0.035, r=0.04):
    """Rollers across a straight run from a to b, in the current frame, lying flat."""
    a, b = np.asarray(a, float), np.asarray(b, float)
    d = (b - a) / np.linalg.norm(b - a)
    side = np.array((-d[1], d[0], 0.0))
    n = int(np.linalg.norm(b - a) / step)
    for i in range(n + 1):
        q = a + d * (i + 0.5) * step
        cyl("roller", q - side * w / 2 + (0, 0, z), q + side * w / 2 + (0, 0, z), r, seg=8, cap=False)


def bead(q, mat="lamp", r=0.036):
    sphere(mat, q, r, seg=7, rings=4)


def rail_posts(a, b, h=0.34, step=1.3, rr=0.022, beads=0):
    a, b = np.asarray(a, float), np.asarray(b, float)
    cyl("steel", a + (0, 0, h), b + (0, 0, h), rr, seg=6)
    n = max(1, int(np.linalg.norm(b - a) / step))
    for i in range(n + 1):
        q = a + (b - a) * i / n
        cyl("steel", q, q + (0, 0, h), rr, seg=6, cap=False)
        if beads and i % beads == 0:
            bead(q + (0, 0, h + 0.03))


def arc_patch(mat, t0, t1, a0, a1, R, nu=12):
    loft(mat, [[(R * math.cos(a), t, R * math.sin(a)) for a in np.linspace(a0, a1, nu)] for t in (t0, t1)], closed=False)


def hatch(t, ang, w, l, kind="door", R=None):
    """Something a suited crew would actually use: a framed door or a louvred vent, flat on the spine."""
    R = R_SP if R is None else R
    with place((R * math.cos(ang), t, R * math.sin(ang)), R=_rot(0, 0, -ang)):
        box("hull2", (0.014, 0, 0), (0.03, l, w), r=0.008)
        if kind == "vent":
            for i in range(6):
                box("rail", (0.032, l * (-0.36 + i * 0.144), 0), (0.012, l * 0.08, w * 0.74), r=0.0)
        else:
            box("hulld", (0.032, 0, 0), (0.012, l * 0.72, w * 0.66), r=0.0)
            box("steel", (0.05, -l * 0.28, 0), (0.024, 0.03, w * 0.34), r=0.0)
            box("lamp", (0.04, l * 0.3, w * 0.24), (0.01, 0.03, 0.03), r=0.0)


def pad(c, R, h=0.2, foil="hull2", n=8, lamps=True):
    """A round work deck bolted on an arm: dark grid top, white rim, a lit edge in the bot's colour, foil-wrapped drum below."""
    cx, cy, cz = c
    rz = math.pi / n
    prism("deck", (cx, cy, cz - 0.05), R * 0.97, 0.05, n=n, rz=rz)
    prism("hull", (cx, cy, cz - h), R, h - 0.05, n=n, rz=rz)
    prism("led_on", (cx, cy, cz - 0.075), R * 1.008, 0.022, n=n, rz=rz)
    prism(foil, (cx, cy, cz - h - 0.42 * R), R * 0.42, 0.42 * R, n=n, rz=rz, top=R * 0.9)
    prism("hull2", (cx, cy, cz - h - 0.5 * R), R * 0.3, 0.08 * R, n=n, rz=rz, top=R * 0.42)
    for gx in np.arange(-R * 0.7, R * 0.71, R * 0.35):
        box("rail", (cx + gx, cy, cz + 0.001), (0.012, R * 1.7, 0.002), r=0.0)
    for gy in np.arange(-R * 0.7, R * 0.71, R * 0.35):
        box("rail", (cx, cy + gy, cz + 0.001), (R * 1.7, 0.012, 0.002), r=0.0)
    for i in range(n):
        a_ = rz + 2 * math.pi * i / n + math.pi / n
        box("steel", (cx + R * 0.86 * math.cos(a_), cy + R * 0.86 * math.sin(a_), cz + 0.006), (0.09, 0.09, 0.012), r=0.0, rz=a_)
        if lamps and i % 2 == 0:
            bead((cx + R * 0.94 * math.cos(a_), cy + R * 0.94 * math.sin(a_), cz + 0.03), r=0.03)
    for i in range(3):
        a_ = 0.5 + i * 2.094
        cyl("steel", (cx + R * 0.72 * math.cos(a_), cy + R * 0.72 * math.sin(a_), cz - h), (cx + R * 0.26 * math.cos(a_), cy + R * 0.26 * math.sin(a_), cz - h - 0.46 * R), 0.03, seg=6)


def arm(a, b, w=0.34, mat="hull", n=None):
    """A short bolted boom: four white chords, braced."""
    a, b = np.asarray(a, float), np.asarray(b, float)
    n = n or max(3, int(np.linalg.norm(b - a) / (w * 2.2)))
    truss(a, b, w, n, mat=mat, rc=0.05, rd=0.022, corners=4, phase=math.pi / 4)
    d, u, v = perp(b - a)
    for q in (a, b):
        cyl("hull2", q - d * 0.1, q + d * 0.1, w * 1.05, seg=8)


# ---------- spine ----------
DECK = 1.02
R_SP = 0.95
T_RING = 31.0
T_G = 10.2
T_A = 21.2
Z_ROLL = 0.63        # height above a deck of the centre of a crate riding on its skid
PTS = {}


def spine():
    t0, t1 = 0.9, T_RING - 0.6
    secs = [(t0, 2.6, "sp_w"), (2.6, 4.3, "sp_g"), (4.3, 8.0, "sp_w"), (8.0, 11.1, "sp_g"), (11.1, 12.5, "mli"), (12.5, 16.2, "sp_w"), (16.2, 19.2, "sp_g"), (19.2, 20.2, "gold_t"), (20.2, 21.6, "mli"), (21.6, 25.4, "sp_w"), (25.4, t1, "sp_g")]
    for a, b, m in secs:
        cyl(m, (0, a, 0), (0, b, 0), R_SP, seg=44, cap=False)
    for tc in [s[0] for s in secs[1:]] + [t1]:
        cyl("hull", (0, tc - 0.13, 0), (0, tc + 0.13, 0), R_SP + 0.08, seg=44)
        cyl("rail", (0, tc - 0.17, 0), (0, tc + 0.17, 0), R_SP + 0.03, seg=44, cap=False)
    for tc in [s_[0] for s_ in secs[1:]] + [t1]:
        for a in np.radians(np.arange(-110, 111, 11)):
            box("steel", ((R_SP + 0.09) * math.cos(a), tc - 0.14, (R_SP + 0.09) * math.sin(a)), (0.05, 0.02, 0.05), r=0.0)
    # foil blankets and hatches on the side you can reach
    for mt, a, b, a0, a1 in (("mli", 4.8, 6.3, -0.75, 0.42), ("silver", 12.9, 14.2, -0.6, 0.2), ("mli", 16.6, 18.4, -0.9, 0.3), ("silver", 22.3, 23.3, -0.7, 0.35), ("mli", 26.4, 28.4, -0.8, 0.1)):
        arc_patch(mt, a, b, a0, a1, R_SP + 0.012)
        for tb in (a, b):
            arc_patch("rail", tb - 0.012, tb + 0.012, a0, a1, R_SP + 0.018, nu=8)
    for tb, an, w_, l_, kd in ((3.0, 0.28, 0.5, 0.8, "vent"), (7.2, 0.5, 0.56, 0.72, "door"), (8.6, -0.5, 0.42, 0.9, "vent"), (11.7, -0.15, 0.5, 0.5, "vent"), (15.2, 0.5, 0.56, 0.72, "door"), (19.8, 0.32, 0.46, 0.86, "vent"), (21.0, -0.42, 0.5, 0.6, "door"), (24.8, 0.4, 0.5, 0.72, "vent")):
        hatch(tb, an, w_, l_, kd)
    cyl("rubber", (0.99, t0, -0.42), (0.99, t1, -0.42), 0.036, seg=8)
    cyl("brass", (0.86, t0, -0.56), (0.86, t1, -0.56), 0.028, seg=8)
    # the cargo deck on top
    box("deck", (0, (t0 + t1) / 2, DECK - 0.07), (2.1, t1 - t0, 0.14), r=0.02)
    for sgn in (-1, 1):
        box("hull", (sgn * 1.08, (t0 + t1) / 2, DECK - 0.11), (0.1, t1 - t0, 0.2), r=0.02)
        rail_posts((sgn * 1.08, t0, DECK), (sgn * 1.08, t1, DECK), h=0.36, step=1.9, beads=2)
    roller_bed((0, t0, DECK), (0, 24.0, DECK), 1.5)
    # the keel and its runs of pipe, under the deck
    truss((0, t0, -1.42), (0, t1, -1.42), 0.42, 22, mat="steel", rc=0.05, rd=0.022, corners=4, phase=math.pi / 4)
    for tb in np.arange(t0 + 0.6, t1, 3.3):
        cyl("hull2", (0, tb, -0.9), (0, tb, -1.1), 0.1, seg=8)
    cyl("steel", (0.98, t0, -0.2), (0.98, t1, -0.2), 0.075, seg=10)
    cyl("steel", (1.02, t0, 0.14), (1.02, t1, 0.14), 0.05, seg=8)
    cyl("brass", (-1.0, t0, 0.1), (-1.0, t1, 0.1), 0.06, seg=8)
    for tb in np.arange(t0 + 1.2, t1, 1.55):
        box("rail", (1.0, tb, -0.03), (0.12, 0.06, 0.46), r=0.01)
    # service boxes, uneven, each with its own hatch
    for tb, h_ in ((5.6, 0.62), (14.1, 0.5), (22.8, 0.72)):
        box("hull2", (0.0, tb, -1.02), (0.9, 1.1, h_), r=0.04)
    use("orange")
    for t_ in np.arange(1.9, 8.4, 0.82):
        for x_ in (-0.97, 0.97):
            box("led_on", (x_, t_, DECK + 0.006), (0.05, 0.42, 0.012), r=0.0)
    use("green")
    for t_ in np.arange(11.0, 20.0, 0.82):
        for x_ in (-0.97, 0.97):
            box("led_on", (x_, t_, DECK + 0.006), (0.05, 0.42, 0.012), r=0.0)
    use("pink")
    for t_ in np.arange(22.4, 24.0, 0.82):
        for x_ in (-0.97, 0.97):
            box("led_on", (x_, t_, DECK + 0.006), (0.05, 0.42, 0.012), r=0.0)


def spine_details():
    """Things sized for a suited person: handrails, small lit ports, thruster quads. They are what make the hull read as big."""
    def at(t, a, r=R_SP):
        return (r * math.cos(a), t, r * math.sin(a))

    for t0, t1, a in ((1.3, 2.5, 0.72), (4.6, 7.0, 0.82), (4.6, 7.6, -0.32), (8.4, 10.7, 0.8), (12.9, 15.9, 0.8), (12.9, 15.4, -0.34), (16.6, 18.9, 0.8), (21.9, 24.8, 0.82), (21.9, 24.8, -0.3)):
        cyl("haz", at(t0, a, R_SP + 0.075), at(t1, a, R_SP + 0.075), 0.011, seg=6)
        for t in np.arange(t0, t1 + 0.01, 0.46):
            cyl("steel", at(t, a), at(t, a, R_SP + 0.075), 0.008, seg=5, cap=False)
    for t0, n_, a in ((5.05, 6, 0.1), (13.2, 7, 0.08), (22.1, 6, 0.06)):
        for i in range(n_):
            t = t0 + i * 0.34
            cyl("hull2", at(t, a), at(t, a, R_SP + 0.012), 0.062, seg=12)
            cyl("glass" if i % 4 == 3 else "winw", at(t, a, R_SP + 0.012), at(t, a, R_SP + 0.016), 0.04, seg=12)
    for t, a in ((3.5, -0.08), (9.5, 0.2), (17.7, 0.16), (25.0, -0.08)):
        with place(at(t, a), R=_rot(0, 0, -a)):
            box("hull2", (0.07, 0, 0), (0.14, 0.22, 0.22), r=0.015)
            for dq in ((0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)):
                b0 = np.array((0.09, 0.0, 0.0)) + np.array(dq) * 0.1
                cyl("rail", b0, b0 + np.array(dq) * 0.075, 0.016, seg=8, r2=0.034)


# ---------- 1: arrivals. A bot waves a ship into the bay ----------
def ship_kit(s_, legs):
    """The ship without its load, nose along the local x axis."""
    ship(np.zeros(3), s=s_, rz=0.0, legs=legs, burn=True)
    box("hull", (-0.2 * s_, 0, 0.36 * s_), (1.0 * s_, 0.52 * s_, 0.05), r=0.01)
    for sgn in (-1, 1):
        bead((-0.5 * s_, sgn * 0.62 * s_, 0.02 * s_), mat="beacon" if sgn < 0 else "lamp", r=0.022 * s_)
        box("hull2", (-0.08 * s_, sgn * 0.335 * s_, -0.06 * s_), (0.26 * s_, 0.012 * s_, 0.16 * s_), r=0.0)
    cyl("steel", (0.3 * s_, 0.1 * s_, 0.24 * s_), (0.3 * s_, 0.1 * s_, 0.64 * s_), 0.008 * s_, seg=6)
    bead((0.3 * s_, 0.1 * s_, 0.65 * s_), mat="beacon", r=0.016 * s_)


def stored(name, q, s, mat, cleared=False, rz=0.0):
    """A crate the line can take away: the plate keeps the empty slot and a live copy stands in it when it is there."""
    with live():
        crate(q, s, mat, cleared, rz=rz)
    PT.spot(name, L((q[0], q[1], q[2] + 0.055 * s)), scale=s, yaw=frame_yaw(rz), kind=mat)


def arrivals():
    use("orange")
    W_, H_, Hb, Lb = 2.5, 2.5, 1.3, 4.6
    ROT = math.radians(68.0)
    ts = np.linspace(0, 2 * np.pi, 84, endpoint=False)

    def ring(y, g=0.0):
        return [((W_ + g) * math.cos(t), y, ((H_ + g) * abs(math.sin(t)) ** 0.78 if math.sin(t) >= 0 else -(Hb + g) * abs(math.sin(t)) ** 0.8)) for t in ts]

    with place((0.15, -1.15, DECK), rz=ROT):
        y0, y1 = -Lb / 2, Lb / 2
        loft("bay_b", [ring(y) for y in np.linspace(y0, y1, 14)])
        loft("rail", [ring(y, -0.08) for y in np.linspace(y0, y1, 4)])
        for y in np.linspace(y0 + 0.5, y1 - 0.02, 5):
            loft("bay_w", [ring(y - 0.09, -0.01), ring(y - 0.09, 0.085), ring(y + 0.09, 0.085), ring(y + 0.09, -0.01)], smooth=False)
        # the mouth: a heavy white rim
        loft("bay_w", [ring(y0 - 0.1, -0.2), ring(y0 - 0.1, 0.13), ring(y0 + 0.14, 0.13), ring(y0 + 0.14, -0.2)], smooth=False)
        loft("led_on", [ring(y0 - 0.105, -0.17), ring(y0 - 0.105, -0.11)], smooth=False)
        # back wall, floor, ceiling lights
        bk = ring(y1 - 0.03, -0.06)
        G.add("hulld", np.array(bk), [tuple(range(len(bk)))], [False])
        box("deck", (0, 0, -0.07), (2 * W_ - 0.3, Lb, 0.14), r=0.0)
        for i in range(10):
            for j in range(5):
                x = (i - 4.5) * 0.48
                z_ = 0.26 + j * 0.46
                if abs(x) / W_ > (1 - (z_ / H_) ** 2) ** 0.5 * 0.86:
                    continue
                box("led_dim" if (i + j) % 4 == 0 else "led_on", (x, y1 - 0.08, z_), (0.42, 0.01, 0.38), r=0.0)
        for x in (-1.5, 0.0, 1.5):
            z_ = (H_ - 0.14) * max(0.05, 1 - (x / W_) ** 2) ** 0.7
            cyl("led_hot", (x, y0 + 0.3, z_), (x, y1 - 0.1, z_), 0.032, seg=6)
        lpoint((0, -0.4, 1.1), tint_e(110), col=tint("orange"), r=0.6)
        lpoint((0, y0 - 1.1, 0.5), tint_e(22), col=tint("orange"), r=0.5)
        # what has already come off the ship rolls over to the side door, where the spine starts
        roller_bed((-0.5, 0.75, 0.0), (W_ - 0.1, 0.75, 0.0), 1.3)
        box("hulld", (W_ - 0.34, 0.75, 0.98), (0.06, 1.7, 1.86), r=0.0)
        for sgn in (-1, 1):
            box("led_hot", (W_ - 0.38, 0.75 + sgn * 0.86, 0.98), (0.02, 0.05, 1.86), r=0.0)
        box("led_hot", (W_ - 0.38, 0.75, 1.92), (0.02, 1.76, 0.05), r=0.0)
        with live():
            crate((0.95, 0.75, 0.56), 0.9, "crate3")
        stored("bay_stack", (-1.7, 1.55, 0.46), 0.9, "crate")
        stored("bay_stack", (-0.72, 1.62, 0.46), 0.9, "crate3", rz=0.08)
        stored("bay_stack", (-1.25, 1.58, 1.37), 0.86, "crate", rz=-0.1)
        PTS["spine_a"] = [L((-0.5, 0.75, Z_ROLL)), L((W_ - 0.1, 0.75, Z_ROLL))]
        PT.spot("bay_mouth", L((0.0, y0 + 0.4, 1.7)))
        # the apron the ship comes in over, with arrows pointing inside
        ya = y0 - 1.75
        box("deck", (0, ya, -0.07), (2 * W_ - 1.1, 3.5, 0.14), r=0.0)
        for sgn in (-1, 1):
            box("hull", (sgn * (W_ - 0.55), ya, -0.12), (0.12, 3.6, 0.24), r=0.02)
            cyl("steel", (sgn * (W_ - 0.8), y0 + 0.1, -1.05), (sgn * (W_ - 0.65), y0 - 3.3, -0.14), 0.05, seg=8)
            rail_posts((sgn * (W_ - 0.55), y0 - 0.1, 0.0), (sgn * (W_ - 0.55), y0 - 3.5, 0.0), h=0.3, step=1.1)
        box("hull", (0, y0 - 3.52, -0.12), (2 * W_ - 1.0, 0.12, 0.24), r=0.02)
        for yy in (y0 - 0.65, y0 - 1.6, y0 - 2.55):
            for sgn in (-1, 1):
                box("led_on", (sgn * 0.44, yy, 0.012), (1.02, 0.15, 0.012), r=0.0, rz=-sgn * math.radians(31))
        # rim lamps, hazard edge, tie-downs, and the docking clamps standing open either side
        for k_, q_ in enumerate(ring(y0 - 0.12, 0.15)):
            if k_ % 6 == 0 and q_[2] > -0.4:
                bead(q_, r=0.04)
        for k_, x in enumerate(np.arange(-W_ + 0.72, W_ - 0.72, 0.34)):
            box("haz" if k_ % 2 else "rail", (x, y0 - 3.42, 0.004), (0.34, 0.12, 0.008), r=0.0)
        for x in np.arange(-1.5, 1.6, 1.0):
            for y_ in (y0 - 1.1, y0 - 2.05, y0 - 3.0):
                cyl("rail", (x, y_, 0.0), (x, y_, 0.012), 0.05, seg=8)
        for sgn in (1,):
            xc = sgn * (W_ - 0.92)
            yc = y0 - 2.55
            box("hulld", (xc, yc, 0.2), (0.46, 0.66, 0.4), r=0.03)
            box("haz", (xc, yc - 0.335, 0.2), (0.34, 0.012, 0.2), r=0.0)
            cyl("steel", (xc, yc, 0.4), (xc + sgn * 0.26, yc - 0.1, 0.98), 0.055, seg=10)
            box("hull2", (xc + sgn * 0.28, yc - 0.1, 1.02), (0.3, 0.46, 0.1), r=0.02)
            bead((xc + sgn * 0.28, yc - 0.1, 1.09), mat="beacon", r=0.035)
        # services along the roof of the shed
        zr = H_ + 0.14
        cyl("steel", (-0.34, y0 + 0.2, zr), (-0.34, y1 - 0.2, zr), 0.05, seg=8)
        cyl("brass", (0.1, y0 + 0.2, zr - 0.02), (0.1, y1 - 0.2, zr - 0.02), 0.04, seg=8)
        box("hull", (0.0, 0.5, zr + 0.14), (1.0, 0.8, 0.32), r=0.04)
        box("hull2", (0.0, -1.1, zr + 0.08), (0.7, 0.5, 0.2), r=0.03)
        # the ship, coming in on its burners with two crates on its back
        sc_ = np.array((2.7, y0 - 5.6, -0.15))
        s_ = 1.86
        ry_ = math.pi / 2 + 0.5
        with live():
            with place(sc_, rz=ry_):
                ship_kit(s_, False)
                crate((-0.42 * s_, 0, 0.62 * s_), 0.46 * s_, "crate3", rz=0.03)
                crate((0.04 * s_, 0, 0.58 * s_), 0.38 * s_, "crate", rz=-0.05)
                for sgn in (-1, 1):
                    a = np.array((-0.96 * s_, sgn * 0.47 * s_, -0.02 * s_))
                    thrust_trail(L(a), L(a + np.array((-2.1 * s_, 0, 0))), r=0.075 * s_)
                lpoint((-1.1 * s_, 0, 0), 2.4, col=(0.4, 0.75, 1.0), r=0.08)
        if PT.ON:
            # Built with its pivot at the world origin, so these spots read as offsets on the ship.
            _xf = G.xf
            G.xf = (_xf[0], np.zeros(3), 1.0)
            with place((0, 0, 0), rz=ry_):
                with live("ship", pivot=(0, 0, 0)):
                    ship_kit(s_, True)
                PT.spot("ship_cargo", L((-0.42 * s_, 0, 0.68 * s_)), scale=0.46 * s_, yaw=frame_yaw(0.03), kind="crate3")
                PT.spot("ship_cargo", L((0.04 * s_, 0, 0.64 * s_)), scale=0.38 * s_, yaw=frame_yaw(-0.05), kind="crate")
                for sgn in (-1, 1):
                    PT.spot("ship_nozzle", L((-0.96 * s_, sgn * 0.47 * s_, -0.02 * s_)), scale=0.075 * s_)
                PT.spot("ship_tail", L((-1.0, 0, 0)))
            G.xf = _xf
            PT.spot("ship_hold", L(sc_))
            PT.spot("ship_land", L((0.1, y0 - 1.72, 0.83)), yaw=-0.5)
            PT.spot("ship_flare", L((1.5, y0 - 3.9, 1.9)))
            PT.spot("ship_exit", L((0.3, y0 - 2.2, 3.2)))
        # the marshal: on its own deck at the corner of the apron, signalling with two lit wands
        pc = np.array((-2.5, y0 - 3.95, -0.1))
        arm(pc + (0.55, 0.62, -0.25), (-1.9, y0 - 2.6, -0.3), w=0.2, n=3)
        pad(tuple(pc), 1.12)
        bs = 0.94
        q = pc + (0, 0, bs * 0.47 + 0.005)
        worker(q, bs, "squircle", sc_, mix=0.62, key="arrivals")
        kicker(q, bs)
        # two wands either side of the body, one high, one out wide: the signal for come ahead
        side = np.array((0.73, -0.68, 0.0))
        fwd = np.cross(side, (0.0, 0.0, 1.0))
        for nm, sgn, up, lean in (("wand_l", -1, 0.62, 0.42), ("wand_r", 1, 0.34, 1.0)):
            b0 = q + side * sgn * bs * 0.72 + (0, 0, bs * (up - 0.3))
            tip = b0 + side * sgn * math.sin(lean) * 0.74 + (0, 0, math.cos(lean) * 0.74)
            with live(nm, pivot=L(b0)):
                cyl("rail", b0 - (tip - b0) * 0.24, b0, 0.052, seg=10)
                cyl("led_hot", b0, tip, 0.05, seg=10)
                sphere("led_hot", tip, 0.05, seg=8, rings=5)
            PT.spot(nm + "_axis", L(b0 + fwd))
            with live():
                lpoint(tuple(tip), 1.0, col=_C["orange"], r=0.1)
    PTS["spine_a"] += [L((0, 2.5, DECK + Z_ROLL)), L((0, T_G - 1.9, DECK + Z_ROLL))]
    PT.path("spine_a", PTS["spine_a"])
    PT.path("gate_in", [L((0, T_G - 1.9, DECK + Z_ROLL)), L((0, T_G - 0.12, DECK + Z_ROLL))])


# ---------- 2: the scan gate across the spine. Crates go in plain and come out with a green band ----------
def gate():
    use("green")
    with live():
        sled(6.7, 0, DECK, 0.92, "crate")
    with place((0, T_G, DECK)):
        for sgn in (-1, 1):
            box("hull", (sgn * 1.52, 0, 1.06), (0.62, 1.04, 2.56), r=0.08)
            box("gold", (sgn * 1.84, 0, 1.0), (0.02, 0.84, 1.8), r=0.0)
            box("hulld", (sgn * 1.52, -0.525, 1.2), (0.36, 0.012, 1.4), r=0.0)
            box("led_on", (sgn * 1.2, -0.3, 1.1), (0.012, 0.09, 2.1), r=0.0)
            box("led_on", (sgn * 1.2, 0.3, 1.1), (0.012, 0.09, 2.1), r=0.0)
            for z_ in (0.42, 0.84, 1.26, 1.68):
                box("steel", (sgn * 1.52, -0.53, z_), (0.2, 0.015, 0.05), r=0.0)
            cyl("steel", (sgn * 1.52, 0, -0.2), (sgn * 0.82, 0, -1.25), 0.075, seg=10)
            for k_ in range(4):
                box("haz" if k_ % 2 else "rail", (sgn * 1.52, -0.528, -0.12 + k_ * 0.12), (0.6, 0.012, 0.12), r=0.0)
            cyl("steel", (sgn * 1.88, -0.3, -0.2), (sgn * 1.88, -0.3, 2.3), 0.032, seg=6)
            cyl("brass", (sgn * 1.88, 0.28, -0.2), (sgn * 1.88, 0.28, 2.3), 0.032, seg=6)
            for z_ in (0.1, 0.8, 1.5, 2.1):
                box("rail", (sgn * 1.87, 0, z_), (0.05, 0.72, 0.05), r=0.0)
            bead((sgn * 1.72, -0.5, 2.84), mat="led_hot", r=0.04)
        box("hull", (0, 0, 2.54), (3.72, 1.12, 0.54), r=0.08)
        box("hull2", (-1.0, 0.0, 2.92), (0.72, 0.62, 0.2), r=0.03)
        box("hull2", (0.72, 0.1, 2.9), (0.46, 0.42, 0.16), r=0.03)
        # A slow turning dish and a whip aerial on the roof: moving parts small enough to give the gate its size.
        cyl("steel", (-1.0, 0.0, 3.0), (-1.0, 0.0, 3.22), 0.04, seg=8)
        with live("dish", pivot=L((-1.0, 0.0, 3.22))):
            lathe("hull", (-1.0, 0.0, 3.3), [(0.001, -0.06), (0.14, -0.04), (0.26, 0.05), (0.3, 0.12), (0.285, 0.125), (0.001, 0.0)], seg=22, rx=0.62)
            cyl("steel", (-1.0, 0.0, 3.24), (-1.0, -0.13, 3.5), 0.012, seg=5)
        PT.spot("dish_axis", L((-1.0, 0.0, 4.22)))
        cyl("steel", (1.2, 0.3, 2.94), (1.2, 0.3, 3.86), 0.007, seg=5)
        bead((1.2, 0.3, 3.88), mat="beacon", r=0.018)
        cyl("brass", (-0.62, 0.1, 2.9), (0.5, 0.1, 2.9), 0.025, seg=6)
        box("mli_f", (0, 0, 2.82), (3.2, 0.84, 0.02), r=0.0)
        box("hulld", (0, 0, 2.25), (2.5, 0.72, 0.06), r=0.0)
        for x in np.arange(-0.96, 0.97, 0.48):
            box("led_hot", (x, 0, 2.215), (0.34, 0.12, 0.02), r=0.0)
        # the sheet of light the crates pass through
        # It lives on the page, in the bot's colour, so the plate only keeps where it goes.
        with live():
            quad("curtain", (-1.2, 0, 0.02), (1.2, 0, 0.02), (1.2, 0, 2.2), (-1.2, 0, 2.2))
        PT.path("gate_sheet", [L((-1.18, 0, 0.02)), L((1.18, 0, 0.02)), L((1.18, 0, 2.2)), L((-1.18, 0, 2.2))])
        PT.spot("gate_glow", L((0, 0, 1.1)))
        PT.spot("gate_along", L((0, 1, 1.1)))
        lpoint((0, -0.6, 1.5), tint_e(16), col=tint("green"), r=0.4)
        lpoint((0, 0.7, 1.5), tint_e(10), col=tint("green"), r=0.4)
    # the crate in the sheet, half read: lit line round it
    z_c = DECK + 0.16 + 0.49
    with live():
        sled(T_G - 0.12, 0, DECK, 0.98, "crate3")
        box("led_hot", (0, T_G, z_c), (1.03, 0.045, 1.03), r=0.0)
        sled(14.1, 0, DECK, 1.0, "crate3", cleared=True)
    # the scanner bot's deck on an arm, set back so it can see into the gate
    pc = np.array((4.15, T_G - 1.5, DECK - 0.1))
    arm((1.12, T_G - 1.3, 0.55), pc + (-0.9, 0.08, -0.3), w=0.26)
    pad(tuple(pc), 1.32)
    bs = 1.12
    q = pc + (0, 0, bs * 0.47 + 0.005)
    target = np.array((0.5, T_G - 0.42, z_c))
    worker(q, bs, "triangle", target, mix=0.62, tool="magnifier", key="gate", scale=1.5, lift=0.12)
    kicker(q, bs)


# ---------- 3: the rack. Cleared cargo goes up in rows ----------
RACK_ROT = math.radians(36.0)
_arm_end_l = np.array((4.2, -1.55))
_c, _s = math.cos(RACK_ROT), math.sin(RACK_ROT)
RACK_C = np.array((-9.4, 21.2)) - np.array((_c * _arm_end_l[0] - _s * _arm_end_l[1], _s * _arm_end_l[0] + _c * _arm_end_l[1]))


def rack():
    use("pink")
    # the turntable in the spine deck where crates turn off
    lathe("hulld", (0, T_A, DECK + 0.002), [(0.0, 0.03), (0.92, 0.03), (0.95, 0.0)], seg=40, smooth=False)
    torus("led_on", (0, T_A, DECK + 0.03), 0.88, 0.016, nu=56, nv=6)
    # the arm with its own rollers
    xa, xb = -1.12, -9.4
    box("deck", ((xa + xb) / 2, T_A, DECK - 0.07), (xa - xb, 1.7, 0.14), r=0.02)
    for sgn in (-1, 1):
        box("hull", ((xa + xb) / 2, T_A + sgn * 0.9, DECK - 0.11), (xa - xb, 0.1, 0.2), r=0.02)
        rail_posts((xa, T_A + sgn * 0.9, DECK), (xb, T_A + sgn * 0.9, DECK), h=0.34, step=1.4)
        for x_ in np.arange(xb + 0.3, xa, 0.82):
            box("led_on", (x_, T_A + sgn * 0.8, DECK + 0.006), (0.42, 0.05, 0.012), r=0.0)
    roller_bed((xa, T_A, DECK), (xb, T_A, DECK), 1.2)
    truss((xa, T_A, -0.05), (xb, T_A, -0.05), 0.46, 12, mat="hull", rc=0.05, rd=0.022, corners=4, phase=math.pi / 4)
    with live():
        sled(T_A, -2.9, DECK, 1.02, "crate", cleared=True, rz=math.pi / 2)
    PTS["spine_b"] = [L((0, T_G - 0.12, DECK + Z_ROLL)), L((0, T_A, DECK + Z_ROLL)), L((-1.1, T_A, DECK + Z_ROLL)), L((xb, T_A, DECK + Z_ROLL))]
    # the yard: a long plate carried on the arm
    W2, D2 = 4.5, 2.35
    with place((RACK_C[0], RACK_C[1], DECK), rz=RACK_ROT):
        box("deck", (0, 0, -0.07), (2 * W2, 2 * D2, 0.14), r=0.02)
        box("hull", (0, 0, -0.26), (2 * W2 + 0.2, 2 * D2 + 0.2, 0.26), r=0.04)
        for sgn in (-1, 1):
            box("led_on", (0, sgn * (D2 + 0.105), -0.1), (2 * W2 + 0.16, 0.012, 0.03), r=0.0)
            box("led_on", (sgn * (W2 + 0.105), 0, -0.1), (0.012, 2 * D2 + 0.16, 0.03), r=0.0)
        box("mli_f", (0, 0, -0.74), (2 * W2 - 1.2, 2 * D2 - 1.1, 0.72), r=0.1)
        for gx in np.arange(-W2 + 0.45, W2, 0.9):
            box("rail", (gx, 0, 0.001), (0.012, 2 * D2 - 0.1, 0.002), r=0.0)
        for gy in np.arange(-D2 + 0.45, D2, 0.9):
            box("rail", (0, gy, 0.001), (2 * W2 - 0.1, 0.012, 0.002), r=0.0)
        # four columns, three rows. The two top right slots are still empty: that is the work left
        cw, ch, cd, cs = 1.34, 1.36, 1.24, 1.12
        x0 = -3.6
        y_r = 0.72
        for i in range(5):
            x_ = x0 + (i - 0.5) * cw
            for sy in (-1, 1):
                box("hull2", (x_, y_r + sy * cd / 2, 3 * ch / 2 + 0.1), (0.1, 0.1, 3 * ch + 0.2), r=0.012)
            if i < 4:
                box("led_dim", (x_ + cw / 2, y_r + cd / 2 + 0.03, 3 * ch + 0.3), (cw * 0.5, 0.012, 0.03), r=0.0)
        for j in range(4):
            z_ = 0.06 + j * ch
            box("steel", (x0 + 1.5 * cw, y_r, z_), (4 * cw + 0.12, cd + 0.12, 0.06), r=0.008)
            box("led_dim", (x0 + 1.5 * cw, y_r - cd / 2 - 0.068, z_), (4 * cw + 0.1, 0.012, 0.022), r=0.0)
        cyl("steel", (x0 - cw / 2, y_r + cd / 2, 0.1), (x0 + 3.5 * cw, y_r + cd / 2, 3 * ch), 0.022, seg=6)
        cyl("steel", (x0 + 3.5 * cw, y_r + cd / 2, 0.1), (x0 - cw / 2, y_r + cd / 2, 3 * ch), 0.022, seg=6)
        rnd = random.Random(9)
        for j in range(3):
            for i in range(4):
                if j == 2 and i >= 2:
                    PT.spot("rack", L((x0 + i * cw, y_r, 0.09 + j * ch + 0.555 * cs)), scale=cs, yaw=frame_yaw(0.0), kind="crate3" if i == 2 else "crate")
                    continue
                qx_, qy_, mt_, rz_ = x0 + i * cw + rnd.uniform(-0.03, 0.03), y_r + rnd.uniform(-0.03, 0.03), rnd.choice(("crate3", "crate", "crate3", "crate2")), rnd.uniform(-0.03, 0.03)
                with live():
                    crate((qx_, qy_, 0.1 + j * ch + cs / 2), cs, mt_, cleared=True, rz=rz_)
                PT.spot("rack", L((qx_, qy_, 0.09 + j * ch + 0.555 * cs)), scale=cs, yaw=frame_yaw(rz_), kind=mt_)
        PT.spot("rack_front", L((0, -1, 0)) - L((0, 0, 0)))
        # the lift beside the rack, raised to the top row, the bot on it with a crate on its head
        lx, ly = 2.0, -0.05
        h_ = 1.62
        box("hulld", (lx, ly, 0.05), (1.7, 1.6, 0.1), r=0.02)
        box("hull2", (lx, ly, h_ + 0.06), (1.7, 1.6, 0.1), r=0.02)
        box("led_on", (lx, ly - 0.805, h_ + 0.06), (1.66, 0.012, 0.03), r=0.0)
        for sy in (-0.6, 0.6):
            for lv in range(3):
                z0, z1 = 0.1 + lv * (h_ - 0.1) / 3, 0.1 + (lv + 1) * (h_ - 0.1) / 3
                cyl("steel", (lx - 0.68, ly + sy, z0), (lx + 0.68, ly + sy, z1), 0.038, seg=8)
                cyl("steel", (lx + 0.68, ly + sy, z0), (lx - 0.68, ly + sy, z1), 0.038, seg=8)
        bs = 1.72
        q = np.array((lx, ly, h_ + 0.11 + bs * 0.47))
        worker(q, bs, "cloud", (x0 + 2 * cw, y_r, h_ + 1.5), mix=0.78, key="rack")
        kicker(q, bs)
        with live():
            crate(q + (0.0, 0.0, bs * 0.47 + 0.02 + 0.5), 1.0, "crate3", cleared=True, rz=0.14)
        PT.spot("lift_head", L(q + (0.0, 0.0, bs * 0.47 + 0.02 + 0.555)), yaw=frame_yaw(0.14))
        foot = L((lx + 1.35, ly, Z_ROLL))
        PTS["spine_b"] += [L((3.4, -1.3, Z_ROLL)), foot]
        PT.path("spine_b", PTS["spine_b"])
        PT.spot("lift_foot", foot)
        PT.spot("tug_home", L((0.6, -1.15, 5.5)))
        PTS["tug"] = [L((0.6, -1.15, 5.5)), L((3.2, -1.7, 4.9))]
        lpoint((lx - 0.4, ly - 0.9, h_ + 1.2), tint_e(12), col=tint("pink"), r=0.4)
        lpoint((-1.4, -1.1, 2.6), tint_e(18), col=tint("pink"), r=0.5)


# ---------- 4: the launch end, the main building: a great ring round the rail, and the lead on its lever ----------
def launch():
    use("amber")
    ZR = DECK + 0.26                       # rail height, and the ring's centre
    R, r = 4.7, 0.72
    Mr = _rot(0, math.pi / 2)
    C = np.array((0, T_RING, ZR))

    def on(a, rad, y=0.0):
        return C + np.array((rad * math.cos(a), y, rad * math.sin(a)))

    def rbox(mat, a, rad, y, size, e=0.012):
        box(mat, on(a, rad, y), size, r=e, ry=-a)

    # the great ring, with a slimmer second ring behind it and bracing between
    torus("ring_w", C, R, r, M=Mr, nu=128, nv=20, zs=1.12)
    C2 = C + (0, 1.7, 0)
    torus("hull2", C2, R + 0.05, 0.3, M=Mr, nu=96, nv=12)
    for a in np.radians(np.arange(8, 360, 30)):
        cyl("steel", on(a, R + 0.35, 0.3), on(a + 0.13, R + 0.1, 1.7), 0.05, seg=8)
        cyl("steel", on(a, R - 0.3, 0.3), on(a - 0.13, R, 1.7), 0.04, seg=8)
    # Insulation on part of the ring: mostly white cloth, one short run of grey film and one of gold, as on real hardware.
    for a0, a1, mt_ in ((20, 62, "mli_r"), (98, 124, "gold_r"), (196, 232, "mli_r"), (288, 322, "silver_r")):
        torus(mt_, C, R, r + 0.018, M=Mr, a0=math.radians(a0), a1=math.radians(a1), nu=48, nv=20, zs=1.12)
    for ad in (20, 62, 98, 124, 196, 232, 288, 322):
        torus("ring_w", C, R, r + 0.05, M=Mr, a0=math.radians(ad - 1.5), a1=math.radians(ad + 1.5), nu=5, nv=20, zs=1.14)
    # the accelerator: coil blocks round the inside, with the light showing between them
    torus("led_hot", C + (0, -0.52, 0), R - r + 0.04, 0.05, M=Mr, nu=160, nv=8)
    torus("led_on", C + (0, 0.42, 0), R - r + 0.02, 0.04, M=Mr, nu=160, nv=8)
    for i in range(30):
        a = 2 * math.pi * i / 30
        rbox("hulld", a, R - r - 0.1, 0.0, (0.34, 0.74, 0.46))
        rbox("hull2", a, R - r - 0.28, 0.0, (0.02, 0.62, 0.34), e=0.0)
    # lit window bands on the front face, calm, in two runs
    for a0, n_, st_ in ((math.radians(66.0), 7, math.radians(3.2)), (math.radians(158.0), 9, math.radians(3.2)), (math.radians(345.0), 8, math.radians(3.2))):
        for i in range(n_):
            a = a0 + i * st_
            q = on(a, R, -r * 1.12 - 0.002)
            box("glass" if i % 5 == 4 else "winw", q, (0.1, 0.012, 0.18), r=0.0, ry=-a)
    # the outer guard rail and its lamps, doors and vents on the face of the ring, a run of service pipe
    torus("rail", C + (0, -0.2, 0), R + r + 0.2, 0.03, M=Mr, nu=128, nv=6)
    for ad in np.arange(4, 360, 15.0):
        a = math.radians(ad)
        cyl("steel", on(a, R + r - 0.04, -0.2), on(a, R + r + 0.2, -0.2), 0.022, seg=6, cap=False)
    for ad in (11, 34, 79, 124, 171, 214, 259, 305, 348):
        bead(on(math.radians(ad), R + r + 0.21, -0.2), r=0.05)
    for ad, kd in ((44, 0), (84, 1), (132, 0), (176, 1), (218, 0), (252, 1), (302, 0), (322, 1)):
        a = math.radians(ad)
        rbox("hull2", a, R + 0.06, -r * 1.14, (0.62, 0.03, 0.46))
        if kd:
            for i in range(5):
                rbox("rail", a, R + 0.06 + (i - 2) * 0.11, -r * 1.14 - 0.02, (0.05, 0.012, 0.36), e=0.0)
        else:
            rbox("hulld", a, R + 0.06, -r * 1.14 - 0.02, (0.44, 0.012, 0.3), e=0.0)
    torus("steel", C + (0, -r * 1.0, 0), R + 0.46, 0.035, M=Mr, a0=math.radians(112), a1=math.radians(166), nu=30, nv=6)
    torus("brass", C + (0, -r * 0.98, 0), R + 0.56, 0.03, M=Mr, a0=math.radians(292), a1=math.radians(352), nu=30, nv=6)
    # three heavy struts tie it to the spine, all below the rail
    for ad in (205, 268, 338):
        a = math.radians(ad)
        p0 = on(a, R - r - 0.1, 0.0)
        p1 = np.array((1.0 * math.cos(a), T_RING - 1.0, ZR - 0.3 + 1.0 * math.sin(a)))
        cyl("hull", p0, p1, 0.2, seg=14)
        m_ = p0 + (p1 - p0) * 0.5
        d_ = (p1 - p0) / np.linalg.norm(p1 - p0)
        cyl("silver_f", m_ - d_ * 0.55, m_ + d_ * 0.55, 0.23, seg=14)
    # capacitor drums either side of the spine: this is where the power for the shot lives
    for sgn, a, b in ((1, 24.6, 29.9), (-1, 25.0, 29.9)):
        x_ = sgn * 1.72
        z_ = -0.82
        cyl("drum_w", (x_, a, z_), (x_, b, z_), 0.62, seg=32)
        cyl("drum_b", (x_, a + 0.8, z_), (x_, b - 1.0, z_), 0.635, seg=32, cap=False)
        cyl("hull2", (x_, a - 0.18, z_), (x_, a, z_), 0.38, seg=24, r2=0.62)
        for yy in (a + 0.8, b - 1.0):
            cyl("hull", (x_, yy - 0.08, z_), (x_, yy + 0.08, z_), 0.68, seg=32)

    # the rail: two bright lines, up off the deck, through the ring and on out into space
    def z_rail(t):
        s_ = min(max((t - 23.0) / 3.0, 0.0), 1.0)
        return DECK + 0.26 * s_ * s_ * (3 - 2 * s_) + 0.13 * max(0.0, t - T_RING) ** 1.16 * 0.72

    T_END = 66.0
    ts_ = np.linspace(23.0, T_END, 60)
    for sgn in (-1, 1):
        for t0, t1 in zip(ts_[:-1], ts_[1:]):
            cyl("steel", (sgn * 0.5, t0, z_rail(t0)), (sgn * 0.5, t1, z_rail(t1)), 0.07, seg=8, cap=False)
            cyl("led_hot", (sgn * 0.42, t0, z_rail(t0) + 0.04), (sgn * 0.42, t1, z_rail(t1) + 0.04), 0.024, seg=6, cap=False)
    for t_ in np.arange(23.4, T_RING, 0.7):
        box("rail", (0, t_, z_rail(t_) - 0.1), (1.34, 0.16, 0.08), r=0.012)
        cyl("steel", (-0.62, t_, DECK), (-0.62, t_, z_rail(t_) - 0.1), 0.03, seg=6, cap=False)
        cyl("steel", (0.62, t_, DECK), (0.62, t_, z_rail(t_) - 0.1), 0.03, seg=6, cap=False)
    # past the ring the rail is carried by a thin lattice
    for t0, t1 in zip(np.arange(T_RING, T_END, 5.0)[:-1], np.arange(T_RING, T_END, 5.0)[1:]):
        truss((0, t0, z_rail(t0) - 0.55), (0, t1, z_rail(t1) - 0.55), 0.36, 4, mat="steel", rc=0.05, rd=0.024, corners=4, phase=math.pi / 4)
    for t_ in np.arange(T_RING + 1.0, T_END, 1.6):
        box("rail", (0, t_, z_rail(t_) - 0.12), (1.3, 0.18, 0.08), r=0.012)
    # the accelerator hoops further out, the same part as the ring in small
    for t_, rr in ((38.0, 1.5), (44.0, 1.5), (54.0, 1.5)):
        c_ = np.array((0, t_, z_rail(t_) + 0.5))
        torus("hull", c_, rr, 0.13, M=Mr, nu=48, nv=10)
        torus("led_hot", c_ + (0, -0.14, 0), rr - 0.1, 0.03, M=Mr, nu=48, nv=6)
        cyl("steel", c_ + (0, 0, -rr), (0, t_, z_rail(t_) - 0.5), 0.05, seg=8)
    # the cargo on its way: a crate in a cage, riding the rail, trailing light back through the ring
    T_POD = 49.0
    pod = np.array((0, T_POD, z_rail(T_POD) + 1.05))
    with live():
        with place(pod, k=1.5):
            prism("podh", (0, 0, -0.52), 0.46, 1.04, n=6, rz=0.3)
            for dz in (-0.54, -0.06, 0.52):
                lathe("steel", (0, 0, dz), [(0.5, -0.05), (0.54, -0.04), (0.54, 0.04), (0.5, 0.05)], seg=6, rz=0.3, smooth=False)
            for i in range(6):
                a = 0.3 + i * math.pi / 3
                cyl("steel", (0.52 * math.cos(a), 0.52 * math.sin(a), -0.54), (0.52 * math.cos(a), 0.52 * math.sin(a), 0.52), 0.035, seg=6)
        lpoint(tuple(pod), 240, col=_C["amber"], r=0.6)

    def tail(t):
        t_ = 33.0 + (T_POD - 1.4 - 33.0) * t
        return L((0, t_, z_rail(t_) + 1.05 * min(1.0, t * 3.0) + 0.04))

    def fd(t, a=0.1):
        q_ = max(0.0, (t - a) / (1.0 - a))
        return q_ * q_ * (3 - 2 * q_)

    with live():
        glow_tube("lc", tail, 0.02, 0.15, lambda t: fd(t))
        glow_tube("lm", tail, 0.06, 0.38, lambda t: fd(t))
        glow_tube("lo", tail, 0.2, 0.9, lambda t: fd(t, 0.05) ** 1.5)
    # the next one waiting on the rail, caged and ready
    tc = 27.0
    zc_ = z_rail(tc) + 0.08
    box("hulld", (0, tc, zc_ + 0.05), (1.3, 1.5, 0.1), r=0.02)

    def caged(c0, mt_="crate3"):
        """A cleared crate in its launch cage, built round c0."""
        crate(c0, 1.1, mt_, cleared=True)
        for x_, y_ in ((-0.64, -0.64), (0.64, -0.64), (-0.64, 0.64), (0.64, 0.64)):
            cyl("steel", (c0[0] + x_, c0[1] + y_, c0[2] - 0.55), (c0[0] + x_, c0[1] + y_, c0[2] + 0.63), 0.035, seg=6)
        for dz_ in (-0.51, 0.63):
            box("steel", (c0[0], c0[1] - 0.64, c0[2] + dz_), (1.32, 0.05, 0.05), r=0.0)
            box("steel", (c0[0], c0[1] + 0.64, c0[2] + dz_), (1.32, 0.05, 0.05), r=0.0)
            box("steel", (c0[0] - 0.64, c0[1], c0[2] + dz_), (0.05, 1.32, 0.05), r=0.0)
            box("steel", (c0[0] + 0.64, c0[1], c0[2] + dz_), (0.05, 1.32, 0.05), r=0.0)

    with live():
        caged((0, tc, zc_ + 0.1 + 0.55))
    if PT.ON:
        with live("pod_o", pivot=(0, 0, 0)):
            caged((0.0, 0.0, 0.0))
        with live("pod_g", pivot=(0, 0, 0)):
            caged((0.0, 0.0, 0.0), "crate")
    PT.spot("cradle", L((0, tc, zc_ + 0.1 + 0.55)))
    PT.path("rail", [L((0, t_, z_rail(t_) + 0.73)) for t_ in np.linspace(tc, 62.0, 30)])
    PT.spot("ring", L(C))
    PT.spot("ring_axis", L(C + np.array((0.0, 1.0, 0.0))))
    with live("ring_sweep", pivot=L(C)):
        for i in range(6):
            a = 2 * math.pi * i / 6 + 0.2
            rbox("led_hot", a, R - r - 0.34, -0.3, (0.05, 0.42, 0.3), e=0.0)
    # The yard tug's run: from over the rack, in front of the solar wings, down to the cradle.
    PTS["tug"] += [L((-3.0, 22.8, 4.5)), L((-0.8, 24.8, 3.9)), L((0, tc, zc_ + 0.65 + 1.5)), L((0, tc, zc_ + 0.65 + 0.78))]
    PT.path("tug", PTS["tug"])
    lpoint(C + (0, -1.5, 0), 240, col=_C["amber"], r=0.8)
    lpoint(C + (0, 2.6, 0), 200, col=_C["amber"], r=0.8)
    # solar wings: this is what charges the drums, on one long mast out the far side
    use("amber")
    mast_a = np.array((-1.1, 25.0, 0.1))
    mast_b = np.array((-11.0, 29.0, 6.6))
    truss(mast_a, mast_b, 0.28, 18, mat="hull", rc=0.05, rd=0.022, corners=4, phase=math.pi / 4)
    um = (mast_b - mast_a) / np.linalg.norm(mast_b - mast_a)
    nw = np.array((0.25, -0.62, 0.74))
    vs = np.cross(nw, um)
    vs = vs / np.linalg.norm(vs) * 1.3
    for tu in (0.5, 0.92):
        cq = mast_a + (mast_b - mast_a) * tu
        solar_wing(cq, um * 1.5, vs, 12, 8, spar="hull", edge=0.035)
        cyl("steel", cq - vs, cq + vs, 0.035, seg=6)
    # the lead's deck on an arm, out to the side where it can watch the rail
    use("main")
    pc = np.array((6.75, 28.1, DECK - 0.2))
    arm((1.15, 27.6, 0.2), pc + (-1.4, -0.1, -0.35), w=0.34)
    pad(tuple(pc), 2.1)
    cyl("steel", (1.9, 27.2, -0.5), pc + (-1.0, -0.35, -0.3), 0.06, seg=8)
    bs = 1.78
    # the launch lever, tipped hard over under the bot's weight
    px, py = pc[0] - 0.95, pc[1] + 0.2
    z_d = pc[2]
    box("hulld", (px, py, z_d + 0.22), (0.7, 0.56, 0.44), r=0.04)
    box("gold2", (px, py - 0.285, z_d + 0.22), (0.5, 0.012, 0.3), r=0.0)
    cyl("steel", (px - 0.36, py, z_d + 0.46), (px + 0.36, py, z_d + 0.46), 0.1, seg=14)
    q = np.array((pc[0] + 0.32, pc[1] - 0.25, z_d + 0.2 + bs * 0.47))
    # beam from the plate under the bot, over the pivot, up to a lit knob
    pl = np.array((pc[0] + 0.32, pc[1] - 0.25, z_d + 0.14))
    tipk = np.array((px - 1.0, py + 0.5, z_d + 1.36))
    box("hull2", tuple(pl), (1.36, 1.2, 0.09), r=0.03, rz=-0.3)
    cyl("hull", pl + (-0.2, 0.1, 0.0), (px, py, z_d + 0.46), 0.1, seg=12)
    use("amber")
    with live("lever", pivot=L((px, py, z_d + 0.46))):
        cyl("hull", (px, py, z_d + 0.46), tipk, 0.09, seg=12, r2=0.07)
        sphere("led_hot", tipk, 0.2, seg=20, rings=12)
    PT.spot("lever_axis", L((px + 1.0, py, z_d + 0.46)))
    lpoint(tuple(tipk + np.array((0.0, -0.3, 0.1))), 6, col=_C["amber"], r=0.2)
    use("main")
    worker(q, bs, "sphere", C, mix=0.66, key="lead")
    kicker(q, bs, e=18.0)
    lpoint(tuple(pc + np.array((0.0, -1.0, 2.2))), 6, col=(1.0, 0.88, 0.75), r=0.5)


with place((0, 0, 0), R=SP_R):
    spine()
    spine_details()
    arrivals()
    gate()
    rack()
    launch()



def _fw(fx, fy, z):
    return CP_np + _c2w((fx, fy), z)


# right at the lens: a grey strut bottom right, far out of focus, the way the pines framed the arctic frame
use("amber")
_a, _b = _fw(1.06, 0.13, 11.0), _fw(0.8, -0.14, 10.0)
with live():
    cyl("hull2", _a, _b, 0.42, seg=24)
    for _t in (0.2, 0.55, 0.85):
        _q = _a + (_b - _a) * _t
        _d0 = (_b - _a) / np.linalg.norm(_b - _a)
        cyl("hull", _q - _d0 * 0.09, _q + _d0 * 0.09, 0.47, seg=24)


def yard_tug():
    """A small yard tug: squat cab, four thruster pods, a grab frame below it for one crate."""
    box("hull", (0, 0, 0), (0.62, 0.46, 0.2), r=0.03)
    box("hull", (0.06, 0, 0.13), (0.34, 0.3, 0.1), r=0.03)
    box("glass", (0.235, 0, 0.13), (0.012, 0.22, 0.06), r=0.0)
    box("hull", (0, 0, -0.16), (0.72, 0.72, 0.04), r=0.01)
    for sx in (-1, 1):
        for sy in (-1, 1):
            cyl("rail", (sx * 0.36, sy * 0.3, -0.06), (sx * 0.36, sy * 0.3, 0.07), 0.058, seg=10)
            cyl("thrust", (sx * 0.36, sy * 0.3, -0.066), (sx * 0.36, sy * 0.3, -0.06), 0.04, seg=10)
            box("steel", (sx * 0.22, sy * 0.2, 0.0), (0.22, 0.05, 0.03), r=0.0)
            cyl("steel", (sx * 0.3, sy * 0.3, -0.16), (sx * 0.3, sy * 0.3, -0.26), 0.012, seg=5)
    bead((0.0, 0.0, 0.2), mat="beacon", r=0.022)
    bead((0.32, 0.2, 0.02), mat="lamp", r=0.016)


if PT.ON:
    # One of each, at unit size in the spine's axes, for the live copies.
    use("orange")
    with place((0, 0, 0), R=SP_R):
        for nm_, mt_, ok_ in (("crate_o", "crate3", False), ("crate_g", "crate", False), ("crate_o_ok", "crate3", True), ("crate_g_ok", "crate", True)):
            with live(nm_, pivot=(0, 0, 0)):
                crate((0.0, 0.0, 0.0), 1.0, mt_, cleared=ok_, skid=True)
        with live("tug", pivot=(0, 0, 0)):
            yard_tug()
    PT.accents(
        arrivals=["led_on_orange", "led_dim_orange", "led_hot_orange"],
        gate=["led_on_green", "led_dim_green", "led_hot_green"],
        rack=["led_on_pink", "led_dim_pink", "led_hot_pink"],
    )
    PT.masks(flow=["atmos"], pulse=["lamp", "beacon", "winw", "window", "led_on_amber", "led_dim_amber"])
    # The three hover pads under the marshal, the scanner and the lead ride slowly on their own thrusters.
    PT.lift([(1.81, -7.45, 0.28, 1.9), (7.66, 5.86, 0.14, 1.75), (19.0, 21.57, 0.05, 2.25)], skip=["atmos", "planet"])
    PT.flat("hull", (0.93, 0.94, 0.93), rough=0.42)
    # Live reflections wash metal out, so each one starts about a fifth darker than its plate material.
    PT.flat("hull2", (0.34, 0.33, 0.31), rough=0.36, metal=1.0)
    PT.flat("hulld", (0.048, 0.052, 0.06), rough=0.38, metal=1.0)
    PT.flat("gold", tuple(v * 0.8 for v in KAPTON), rough=0.33, metal=1.0)
    PT.flat("rail", (0.04, 0.042, 0.048), rough=0.4, metal=1.0)
    PT.flat("steel", (0.37, 0.376, 0.4), rough=0.34, metal=1.0)
G.build()
CUR.clear()
print("station built", flush=True)
_cv = (TG - CP).normalized()
_cr = _cv.cross(Vector((0, 0, 1))).normalized()
_cu = _cr.cross(_cv).normalized()

# ---------- planet and atmosphere ----------
bm = bmesh.new()
bmesh.ops.create_uvsphere(bm, u_segments=512, v_segments=256, radius=1.0)
_pv = np.array([v.co[:] for v in bm.verts])
_idx = {v: i for i, v in enumerate(bm.verts)}
_pf = [tuple(_idx[v] for v in f.verts) for f in bm.faces]
bm.free()
for nm, rad, mt in (("planet", P_R, "planet"), ("atmos", P_R * 1.032, "atmos")):
    me = bpy.data.meshes.new(nm)
    me.from_pydata(_pv.tolist(), [], _pf)
    me.polygons.foreach_set("use_smooth", [True] * len(_pf))
    me.update()
    me.materials.append(MATS[mt])
    o = bpy.data.objects.new(nm, me)
    o.location = P_C
    o.scale = (rad, rad, rad)
    # turn the cloud pattern to a good part of it
    o.rotation_euler = (0.7, 0.3, 1.1)
    o.visible_shadow = False
    bpy.context.collection.objects.link(o)
print("planet built", P_C, P_R, flush=True)

# ---------- world ----------
w = bpy.data.worlds.new("sky")
bpy.context.scene.world = w
w.use_nodes = True
nt = w.node_tree
bg = nt.nodes["Background"]
bg.inputs["Color"].default_value = (0.0016, 0.005, 0.018, 1)
bg.inputs["Strength"].default_value = 1.0
_Nw = Nodes(nt)
_lp = nt.nodes.new("ShaderNodeLightPath")
_dw = _Nw.tc.outputs["Generated"]


def _lobe(dirv, power, gain):
    d_ = Vector(dirv).normalized()
    return _Nw.math("MULTIPLY", _Nw.math("POWER", _Nw.math("MAXIMUM", _Nw.vec("DOT_PRODUCT", _dw, tuple(d_)), 0.0), power), gain)


_env = (0.0016, 0.005, 0.018, 1)
for _dirv, _pw, _gn, _cl in (((0, 0, -1), 1.4, 0.5, (0.42, 0.5, 0.86)), ((0, 0, 1), 1.8, 0.2, (1.0, 0.96, 0.9)), (tuple(SUN_DIR), 16.0, 2.6, (1.0, 0.9, 0.78)), ((-0.85, -0.3, 0.42), 7.0, 0.9, (0.72, 0.84, 1.0))):
    _env = _Nw.mix(1.0, _env, _Nw.mix(1.0, _cl, _lobe(_dirv, _pw, _gn), "MULTIPLY"), "ADD")
nt.links.new(_Nw.mix(_lp.outputs["Is Glossy Ray"], (0.0016, 0.005, 0.018, 1), _env), bg.inputs["Color"])

# ---------- sun: hard key ----------
sun = bpy.data.lights.new("sun", "SUN")
sun.energy = 7.6
sun.color = (1.0, 0.92, 0.84)
sun.angle = math.radians(1.1)
so = bpy.data.objects.new("sun", sun)
so.rotation_euler = SUN_DIR.to_track_quat("Z", "Y").to_euler()
bpy.context.collection.objects.link(so)
# the hub gets its own share of the key, same direction and colour, so it is the best lit thing in frame
hk = bpy.data.lights.new("hubkey", "SPOT")
hk.energy = 85000.0
hk.color = (1.0, 0.92, 0.84)
hk.spot_size = math.radians(34.0)
hk.spot_blend = 0.4
hk.shadow_soft_size = 0.25
hko = bpy.data.objects.new("hubkey", hk)
hko.location = Vector(((np.array((0.0, T_RING, 1.3)) @ SP_R.T)).tolist()) + SUN_DIR * 44.0
hko.rotation_euler = (-SUN_DIR).to_track_quat("-Z", "Y").to_euler()
bpy.context.collection.objects.link(hko)
# soft planet fill, a weak blue from below on top of what the planet itself returns
fill = bpy.data.lights.new("fill", "SUN")
fill.energy = 0.85
fill.color = (0.24, 0.48, 1.0)
fill.angle = math.radians(60)
fo = bpy.data.objects.new("fill", fill)
_fd = (-_cv * 0.75 - _cu * 0.45 + Vector((0, 0, 0.1))).normalized()
fo.rotation_euler = _fd.to_track_quat("Z", "Y").to_euler()
bpy.context.collection.objects.link(fo)

# ---------- camera ----------
cd = bpy.data.cameras.new("cam")
cd.lens = CAM_LENS
cd.sensor_width = 36
cd.clip_start = 0.1
cd.clip_end = 100000.0
co = bpy.data.objects.new("cam", cd)
co.location = CP
co.rotation_euler = (TG - CP).to_track_quat("-Z", "Y").to_euler()
bpy.context.collection.objects.link(co)
bpy.context.scene.camera = co
cd.dof.use_dof = True
cd.dof.focus_distance = FOCUS
cd.dof.aperture_fstop = FSTOP
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
sc.cycles.max_bounces = 8
sc.cycles.transparent_max_bounces = 16
sc.cycles.sample_clamp_direct = 24.0
sc.cycles.sample_clamp_indirect = 8.0
sc.render.resolution_x = WIDTH
sc.render.resolution_y = round(WIDTH * 9 / 16)
sc.render.resolution_percentage = 100
if CROP:
    sc.render.use_border = True
    sc.render.use_crop_to_border = True
    sc.render.border_min_x, sc.render.border_min_y, sc.render.border_max_x, sc.render.border_max_y = CROP
sc.render.image_settings.file_format = "PNG"
sc.render.filepath = OUT
sc.view_settings.view_transform = "AgX"
sc.view_settings.look = "AgX - Punchy"
sc.view_settings.exposure = 0.3
try:
    tree = bpy.data.node_groups.new("post", "CompositorNodeTree")
    tree.interface.new_socket(name="Image", in_out="OUTPUT", socket_type="NodeSocketColor")
    sc.compositing_node_group = tree
    rl = tree.nodes.new("CompositorNodeRLayers")
    gl = tree.nodes.new("CompositorNodeGlare")
    gl.inputs["Type"].default_value = "Bloom"
    gl.inputs["Quality"].default_value = "High"
    for nm, val in (("Threshold", 0.72), ("Smoothness", 0.7), ("Strength", 0.62), ("Saturation", 1.15), ("Size", 0.66)):
        gl.inputs[nm].default_value = val
    ou = tree.nodes.new("NodeGroupOutput")
    src_out = rl.outputs["Image"]
    try:
        bpy.context.view_layer.use_pass_mist = True
        ms = bpy.context.scene.world.mist_settings
        ms.start, ms.depth, ms.falloff = 70.0, 36.0, "LINEAR"
        mr = tree.nodes.new("ShaderNodeMapRange")
        mr.inputs["To Max"].default_value = 0.14
        fg = tree.nodes.new("ShaderNodeMix")
        fg.data_type = "RGBA"
        fg.inputs["B"].default_value = (0.012, 0.04, 0.12, 1)
        tree.links.new(rl.outputs["Mist"], mr.inputs["Value"])
        tree.links.new(mr.outputs[0], fg.inputs["Factor"])
        tree.links.new(rl.outputs["Image"], fg.inputs["A"])
        src_out = fg.outputs["Result"]
        print("HAZE on", flush=True)
    except Exception as ex2_:
        print("HAZE SKIPPED", repr(ex2_), flush=True)
    tree.links.new(src_out, gl.inputs["Image"])
    tree.links.new(gl.outputs["Image"], ou.inputs[0])
    sc.render.use_compositing = True
except Exception as ex:
    print("POST SKIPPED", repr(ex), flush=True)
    sc.compositing_node_group = None
    sc.render.use_compositing = False
if SAVE:
    bpy.ops.wm.save_as_mainfile(filepath=SAVE)
_meshes = {o.data.name: len(o.data.polygons) for o in bpy.data.objects if o.type == "MESH"}
print("objects", len(bpy.data.objects), "unique faces", sum(_meshes.values()), flush=True)
if PT.ON:
    _pass_accent = PT.pass_accent

    def _accent_clean():
        """The haze would lay its colour over the whole accent image, and the page would read that as station light."""
        mr.inputs["To Max"].default_value = 0.0
        _pass_accent()
        mr.inputs["To Max"].default_value = 0.14

    PT.pass_accent = _accent_clean
    PT.finish(co, env_center=Vector((SP_R @ np.array((0.0, 16.0, 3.0))).tolist()))
    sys.exit(0)
bpy.ops.render.render(write_still=True)
print("DONE", OUT, flush=True)
