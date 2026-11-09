"""Hover Isles, the sun harvest: three bots on a line of floating isles climbing towards the sun.
Crop is cut on the lowest isle, drones hop the baskets up, a wind driven press turns them into jars on the
middle isle, and the white lead pours the jars into the beacon on the highest isle. Look test in Cycles.

Run through the queue: tools/render.sh blender/hover-isles/island_look.py <out.png> <width> <samples> [save.blend] [--border x0,y0,x1,y1]
"""
import math
import os
import random
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector, noise
from mathutils.bvhtree import BVHTree

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "shared"))
import mascots
import plate_tools as PT

ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = ARGS[0] if ARGS else "/tmp/hover.png"
WIDTH = int(ARGS[1]) if len(ARGS) > 1 else 1280
SAMPLES = int(ARGS[2]) if len(ARGS) > 2 else 48
SAVE = next((a for a in ARGS[3:] if a.endswith(".blend")), None)

random.seed(11)
np.random.seed(11)
PT.setup(ARGS, globals())
CURCFG = None

for o in list(bpy.data.objects):
    bpy.data.objects.remove(o)


# ---------- the line: colours and shapes are config, each station is written for its job ----------
WORLD_CFG = [
    dict(key="harvest", color=(0.04, 0.48, 1.0), shape="pentagon", state="working", x=-5.8, y=15.0, z=-1.5, scale=0.82, R=4.3, D=2.5, seed=31, bs=1.06, tilt=math.radians(10), station="field"),
    dict(key="relay1", color=(0.02, 0.72, 1.0), shape=None, state="idle", x=-5.0, y=19.5, z=0.9, scale=1.0, R=1.2, D=1.35, seed=43, bs=0.5, tilt=math.radians(6), station="relay", fall=-60),
    dict(key="press", color=(1.0, 0.1, 0.42), shape="cloud", state="working", x=0.4, y=22.0, z=1.7, scale=1.08, R=3.2, D=2.9, seed=19, bs=1.04, tilt=math.radians(7), station="press"),
    dict(key="relay2", color=(0.02, 0.72, 1.0), shape=None, state="idle", x=5.2, y=26.0, z=3.85, scale=1.0, R=1.15, D=1.3, seed=53, bs=0.5, tilt=math.radians(5), station="relay", trees=0),
    dict(key="lead", color=(0.9, 0.91, 0.93), shape="sphere", state="main", x=11.7, y=33.0, z=6.6, scale=1.3, R=3.0, D=2.8, seed=7, bs=1.12, tilt=math.radians(1), station="beacon"),
]

# ---------- camera: low, wide and looking up across the line, so each isle is seen from further below than the last ----------
LENS = 28.0
PITCH = math.radians(-3.5)
_fwd = Vector((0.0, math.cos(PITCH), -math.sin(PITCH)))
_right = Vector((1.0, 0.0, 0.0))
_up = _right.cross(_fwd).normalized()
CAMD = 34.0
CP = Vector((0.0, 0.0, 0.0))
TG = CP + _fwd * 22.0
CAMXY = (CP.x, CP.y)
# The clouds end just under true level.
HZ = math.radians(1.8)
H0 = math.sin(HZ)
FLOOR_Z = -11.0
CLOUD_EDGE = (CP.z - FLOOR_Z) / math.tan(HZ)


def dir_from(az, el):
    a, e = math.radians(az), math.radians(el)
    return Vector((math.sin(a) * math.cos(e), math.cos(a) * math.cos(e), math.sin(e)))


SUN_DIR = dir_from(-100, 19)                 # the key light, from behind the left shoulder so faces read
RIM_DIR = dir_from(27, 15)                   # the sun itself: rims and glowing cloud edges
VSUN = dir_from(29, 16)                      # the disc painted in the sky, where the line of isles is heading
SKY_GAIN = 0.9
SKY_LIGHT = 0.5     # how much of the painted sky reaches the scene as light


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


def ramp(nt, stops):
    r = nt.nodes.new("ShaderNodeValToRGB")
    c = r.color_ramp
    c.elements[0].position, c.elements[0].color = stops[0][0], (*stops[0][1], 1)
    c.elements[1].position, c.elements[1].color = stops[-1][0], (*stops[-1][1], 1)
    for p, col in stops[1:-1]:
        c.elements.new(p).color = (*col, 1)
    return r


def sky_nodes(nt, dir_sock):
    """The sky as a function of view direction. Shared by the world and the far clouds, so the sea dissolves into it."""
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(dir_sock, sep.inputs[0])
    e = nt.nodes.new("ShaderNodeMath")
    e.operation = "ADD"
    e.inputs[1].default_value = H0
    nt.links.new(sep.outputs["Z"], e.inputs[0])
    warm = ramp(nt, [(0.0, (1.0, 0.34, 0.04)), (0.03, (1.0, 0.4, 0.07)), (0.075, (1.0, 0.48, 0.13)), (0.14, (1.0, 0.5, 0.13)), (0.22, (0.95, 0.54, 0.2)), (0.34, (0.42, 0.56, 0.56)), (0.6, (0.06, 0.28, 0.55))])
    cool = ramp(nt, [(0.0, (0.98, 0.46, 0.24)), (0.03, (0.95, 0.5, 0.3)), (0.075, (0.84, 0.58, 0.44)), (0.14, (0.55, 0.66, 0.66)), (0.22, (0.24, 0.6, 0.72)), (0.34, (0.09, 0.46, 0.7)), (0.6, (0.03, 0.2, 0.48))])
    nt.links.new(e.outputs[0], warm.inputs["Fac"])
    nt.links.new(e.outputs[0], cool.inputs["Fac"])
    # gold on the sun side of the frame, rose towards the far side
    side = nt.nodes.new("ShaderNodeMapRange")
    side.interpolation_type = "SMOOTHSTEP"
    side.inputs["From Min"].default_value = -0.3
    side.inputs["From Max"].default_value = 0.4
    nt.links.new(sep.outputs["X"], side.inputs["Value"])
    mx = nt.nodes.new("ShaderNodeMix")
    mx.data_type = "RGBA"
    nt.links.new(side.outputs[0], mx.inputs["Factor"])
    nt.links.new(cool.outputs["Color"], mx.inputs["A"])
    nt.links.new(warm.outputs["Color"], mx.inputs["B"])
    # halo and disc of the low sun
    dot = nt.nodes.new("ShaderNodeVectorMath")
    dot.operation = "DOT_PRODUCT"
    dot.inputs[1].default_value = VSUN
    nt.links.new(dir_sock, dot.inputs[0])
    clamp = nt.nodes.new("ShaderNodeMath")
    clamp.operation = "MAXIMUM"
    clamp.inputs[1].default_value = 0.0
    nt.links.new(dot.outputs["Value"], clamp.inputs[0])
    acc = mx.outputs["Result"]
    for pw, col in ((26.0, (1.5, 0.6, 0.06)), (220.0, (3.0, 1.2, 0.2)), (2600.0, (2.6, 1.5, 0.6)), (26000.0, (6.0, 3.8, 1.6))):
        p = nt.nodes.new("ShaderNodeMath")
        p.operation = "POWER"
        p.inputs[1].default_value = pw
        nt.links.new(clamp.outputs[0], p.inputs[0])
        a = nt.nodes.new("ShaderNodeVectorMath")
        a.operation = "MULTIPLY_ADD"
        a.inputs[1].default_value = col
        nt.links.new(p.outputs[0], a.inputs[0])
        nt.links.new(acc, a.inputs[2])
        acc = a.outputs[0]
    g = nt.nodes.new("ShaderNodeVectorMath")
    g.operation = "SCALE"
    g.inputs["Scale"].default_value = SKY_GAIN
    nt.links.new(acc, g.inputs[0])
    return g.outputs[0]


def mat_cloud():
    """Cotton: sculpted puffs with deep subsurface, warm on top, cool in the valleys, dissolving into the sky far away."""
    m = bpy.data.materials.new("cloud")
    m.use_nodes = True
    nt = m.node_tree
    p = nt.nodes["Principled BSDF"]
    geo = nt.nodes.new("ShaderNodeNewGeometry")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(geo.outputs["Position"], sep.inputs[0])
    h = nt.nodes.new("ShaderNodeMapRange")
    h.inputs["From Min"].default_value = FLOOR_Z - 2.0
    h.inputs["From Max"].default_value = FLOOR_Z + 13.0
    nt.links.new(sep.outputs["Z"], h.inputs["Value"])
    col = ramp(nt, [(0.0, (0.26, 0.38, 0.66)), (0.35, (0.56, 0.62, 0.84)), (0.7, (0.98, 0.8, 0.66)), (1.0, (1.0, 0.86, 0.72))])
    nt.links.new(h.outputs[0], col.inputs["Fac"])
    nt.links.new(col.outputs["Color"], p.inputs["Base Color"])
    p.inputs["Roughness"].default_value = 0.95
    p.inputs["Specular IOR Level"].default_value = 0.2
    p.inputs["Subsurface Weight"].default_value = 1.0
    p.inputs["Subsurface Radius"].default_value = (1.0, 0.55, 0.32)
    p.inputs["Subsurface Scale"].default_value = 0.3
    p.inputs["Sheen Weight"].default_value = 0.5
    p.inputs["Sheen Roughness"].default_value = 0.45
    # fibre: fine combed bump so close puffs read as handmade cotton
    n1 = nt.nodes.new("ShaderNodeTexNoise")
    n1.inputs["Scale"].default_value = 2.4
    n1.inputs["Detail"].default_value = 9
    n1.inputs["Roughness"].default_value = 0.62
    nt.links.new(geo.outputs["Position"], n1.inputs["Vector"])
    b1 = nt.nodes.new("ShaderNodeBump")
    b1.inputs["Strength"].default_value = 0.35
    b1.inputs["Distance"].default_value = 0.14
    nt.links.new(n1.outputs["Fac"], b1.inputs["Height"])
    n2 = nt.nodes.new("ShaderNodeTexNoise")
    n2.inputs["Scale"].default_value = 0.55
    n2.inputs["Detail"].default_value = 6
    n2.inputs["Roughness"].default_value = 0.6
    nt.links.new(geo.outputs["Position"], n2.inputs["Vector"])
    b2 = nt.nodes.new("ShaderNodeBump")
    b2.inputs["Strength"].default_value = 0.3
    b2.inputs["Distance"].default_value = 0.7
    nt.links.new(n2.outputs["Fac"], b2.inputs["Height"])
    nt.links.new(b2.outputs["Normal"], b1.inputs["Normal"])
    nt.links.new(b1.outputs["Normal"], p.inputs["Normal"])
    # aerial perspective
    cam = nt.nodes.new("ShaderNodeCameraData")
    hz = nt.nodes.new("ShaderNodeMapRange")
    hz.interpolation_type = "SMOOTHSTEP"
    hz.inputs["From Min"].default_value = 62.0
    hz.inputs["From Max"].default_value = CLOUD_EDGE * 0.96
    nt.links.new(cam.outputs["View Distance"], hz.inputs["Value"])
    neg = nt.nodes.new("ShaderNodeVectorMath")
    neg.operation = "SCALE"
    neg.inputs["Scale"].default_value = -1.0
    nt.links.new(geo.outputs["Incoming"], neg.inputs[0])
    em = nt.nodes.new("ShaderNodeEmission")
    nt.links.new(sky_nodes(nt, neg.outputs[0]), em.inputs["Color"])
    mix = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(hz.outputs[0], mix.inputs[0])
    nt.links.new(p.outputs[0], mix.inputs[1])
    nt.links.new(em.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], nt.nodes["Material Output"].inputs[0])
    return m


def moss_col(nt, tc_out):
    n = nt.nodes.new("ShaderNodeTexNoise")
    n.inputs["Scale"].default_value = 1.9
    n.inputs["Detail"].default_value = 7
    n.inputs["Roughness"].default_value = 0.6
    nt.links.new(tc_out, n.inputs["Vector"])
    r = ramp(nt, [(0.3, (0.05, 0.11, 0.022)), (0.46, (0.11, 0.2, 0.036)), (0.6, (0.26, 0.33, 0.06)), (0.72, (0.5, 0.44, 0.1))])
    nt.links.new(n.outputs["Fac"], r.inputs["Fac"])
    return r.outputs["Color"]


def mat_rock():
    m = bpy.data.materials.new("rock")
    m.use_nodes = True
    nt = m.node_tree
    r = nt.nodes["Principled BSDF"]
    r.inputs["Roughness"].default_value = 0.8
    tc = nt.nodes.new("ShaderNodeTexCoord")
    n1 = nt.nodes.new("ShaderNodeTexNoise")
    n1.inputs["Scale"].default_value = 3.0
    n1.inputs["Detail"].default_value = 10
    n1.inputs["Roughness"].default_value = 0.62
    nt.links.new(tc.outputs["Object"], n1.inputs["Vector"])
    cr = ramp(nt, [(0.34, (0.16, 0.13, 0.12)), (0.5, (0.36, 0.31, 0.27)), (0.74, (0.7, 0.61, 0.5))])
    wave = nt.nodes.new("ShaderNodeTexWave")
    wave.wave_type = "BANDS"
    wave.bands_direction = "Z"
    wave.inputs["Scale"].default_value = 1.15
    wave.inputs["Distortion"].default_value = 8.0
    wave.inputs["Detail"].default_value = 5
    nt.links.new(tc.outputs["Object"], wave.inputs["Vector"])
    fac = nt.nodes.new("ShaderNodeMath")
    fac.operation = "MULTIPLY_ADD"
    fac.inputs[1].default_value = 0.55
    nt.links.new(n1.outputs["Fac"], fac.inputs[0])
    wv2 = nt.nodes.new("ShaderNodeMath")
    wv2.operation = "MULTIPLY"
    wv2.inputs[1].default_value = 0.2
    nt.links.new(wave.outputs["Fac"], wv2.inputs[0])
    nt.links.new(wv2.outputs[0], fac.inputs[2])
    nt.links.new(fac.outputs[0], cr.inputs["Fac"])
    crk = nt.nodes.new("ShaderNodeTexVoronoi")
    crk.feature = "DISTANCE_TO_EDGE"
    crk.inputs["Scale"].default_value = 1.5
    nt.links.new(tc.outputs["Object"], crk.inputs["Vector"])
    crr = ramp(nt, [(0.0, (0.8, 0.77, 0.74)), (0.02, (1, 1, 1))])
    nt.links.new(crk.outputs["Distance"], crr.inputs["Fac"])
    rmix = nt.nodes.new("ShaderNodeMix")
    rmix.data_type = "RGBA"
    rmix.blend_type = "MULTIPLY"
    rmix.inputs["Factor"].default_value = 1.0
    nt.links.new(cr.outputs["Color"], rmix.inputs["A"])
    nt.links.new(crr.outputs["Color"], rmix.inputs["B"])
    nt.links.new(rmix.outputs["Result"], r.inputs["Base Color"])
    n2 = nt.nodes.new("ShaderNodeTexNoise")
    n2.inputs["Scale"].default_value = 24
    n2.inputs["Detail"].default_value = 8
    nt.links.new(tc.outputs["Object"], n2.inputs["Vector"])
    bp = nt.nodes.new("ShaderNodeBump")
    bp.inputs["Strength"].default_value = 0.9
    bp.inputs["Distance"].default_value = 0.09
    hgt = nt.nodes.new("ShaderNodeMath")
    hgt.operation = "MULTIPLY_ADD"
    hgt.inputs[1].default_value = 0.7
    nt.links.new(n2.outputs["Fac"], hgt.inputs[0])
    nt.links.new(crr.outputs["Color"], hgt.inputs[2])
    nt.links.new(hgt.outputs[0], bp.inputs["Height"])
    nt.links.new(bp.outputs["Normal"], r.inputs["Normal"])
    # moss on top, ragged where it spills over the lip
    s = nt.nodes.new("ShaderNodeBsdfPrincipled")
    s.inputs["Roughness"].default_value = 0.9
    s.inputs["Sheen Weight"].default_value = 0.7
    nt.links.new(moss_col(nt, tc.outputs["Object"]), s.inputs["Base Color"])
    n5 = nt.nodes.new("ShaderNodeTexNoise")
    n5.inputs["Scale"].default_value = 60
    n5.inputs["Detail"].default_value = 5
    nt.links.new(tc.outputs["Object"], n5.inputs["Vector"])
    b5 = nt.nodes.new("ShaderNodeBump")
    b5.inputs["Strength"].default_value = 0.8
    b5.inputs["Distance"].default_value = 0.03
    nt.links.new(n5.outputs["Fac"], b5.inputs["Height"])
    nt.links.new(b5.outputs["Normal"], s.inputs["Normal"])
    at = nt.nodes.new("ShaderNodeAttribute")
    at.attribute_name = "moss"
    n3 = nt.nodes.new("ShaderNodeTexNoise")
    n3.inputs["Scale"].default_value = 11
    n3.inputs["Detail"].default_value = 6
    nt.links.new(tc.outputs["Object"], n3.inputs["Vector"])
    mx = nt.nodes.new("ShaderNodeMath")
    mx.operation = "MULTIPLY_ADD"
    mx.inputs[1].default_value = 0.55
    nt.links.new(n3.outputs["Fac"], mx.inputs[0])
    nt.links.new(at.outputs["Fac"], mx.inputs[2])
    rp = ramp(nt, [(0.62, (0, 0, 0)), (0.72, (1, 1, 1))])
    nt.links.new(mx.outputs[0], rp.inputs["Fac"])
    mix = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(rp.outputs["Color"], mix.inputs[0])
    nt.links.new(r.outputs[0], mix.inputs[1])
    nt.links.new(s.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], nt.nodes["Material Output"].inputs[0])
    return m


def mat_grass():
    m = bpy.data.materials.new("grass")
    m.use_nodes = True
    nt = m.node_tree
    p = nt.nodes["Principled BSDF"]
    p.inputs["Roughness"].default_value = 0.62
    tc = nt.nodes.new("ShaderNodeTexCoord")
    at = nt.nodes.new("ShaderNodeAttribute")
    at.attribute_name = "tip"
    k = nt.nodes.new("ShaderNodeMapRange")
    k.inputs["To Min"].default_value = 0.45
    k.inputs["To Max"].default_value = 1.75
    nt.links.new(at.outputs["Fac"], k.inputs["Value"])
    sc = nt.nodes.new("ShaderNodeVectorMath")
    sc.operation = "SCALE"
    nt.links.new(moss_col(nt, tc.outputs["Object"]), sc.inputs[0])
    nt.links.new(k.outputs[0], sc.inputs["Scale"])
    nt.links.new(sc.outputs[0], p.inputs["Base Color"])
    t = nt.nodes.new("ShaderNodeBsdfTranslucent")
    nt.links.new(sc.outputs[0], t.inputs["Color"])
    mix = nt.nodes.new("ShaderNodeMixShader")
    mix.inputs[0].default_value = 0.35
    nt.links.new(p.outputs[0], mix.inputs[1])
    nt.links.new(t.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], nt.nodes["Material Output"].inputs[0])
    return m


def mat_leaf(name, col, col2):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    p = nt.nodes["Principled BSDF"]
    p.inputs["Roughness"].default_value = 0.68
    tc = nt.nodes.new("ShaderNodeTexCoord")
    n = nt.nodes.new("ShaderNodeTexNoise")
    n.inputs["Scale"].default_value = 26
    n.inputs["Detail"].default_value = 6
    nt.links.new(tc.outputs["Object"], n.inputs["Vector"])
    r = ramp(nt, [(0.34, col), (0.66, col2)])
    nt.links.new(n.outputs["Fac"], r.inputs["Fac"])
    nt.links.new(r.outputs["Color"], p.inputs["Base Color"])
    b = nt.nodes.new("ShaderNodeBump")
    b.inputs["Strength"].default_value = 1.0
    b.inputs["Distance"].default_value = 0.05
    nt.links.new(n.outputs["Fac"], b.inputs["Height"])
    nt.links.new(b.outputs["Normal"], p.inputs["Normal"])
    t = nt.nodes.new("ShaderNodeBsdfTranslucent")
    nt.links.new(r.outputs["Color"], t.inputs["Color"])
    mix = nt.nodes.new("ShaderNodeMixShader")
    mix.inputs[0].default_value = 0.3
    nt.links.new(p.outputs[0], mix.inputs[1])
    nt.links.new(t.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], nt.nodes["Material Output"].inputs[0])
    return m


def mat_fall(name="fall"):
    """A thread of falling water: streaked, fading out completely as it dissolves into mist."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    p = nt.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (0.92, 0.97, 1.0, 1)
    p.inputs["Roughness"].default_value = 0.35
    p.inputs["Emission Color"].default_value = (1.0, 0.86, 0.68, 1)
    p.inputs["Emission Strength"].default_value = 0.12
    at = nt.nodes.new("ShaderNodeAttribute")
    at.attribute_name = "fade"
    tc = nt.nodes.new("ShaderNodeTexCoord")
    mp = nt.nodes.new("ShaderNodeMapping")
    mp.inputs["Scale"].default_value = (34, 34, 1.3)
    nt.links.new(tc.outputs["Object"], mp.inputs["Vector"])
    n = nt.nodes.new("ShaderNodeTexNoise")
    n.inputs["Scale"].default_value = 1.0
    n.inputs["Detail"].default_value = 5
    nt.links.new(mp.outputs[0], n.inputs["Vector"])
    r = nt.nodes.new("ShaderNodeMapRange")
    r.inputs["From Min"].default_value = 0.34
    r.inputs["From Max"].default_value = 0.62
    r.inputs["To Min"].default_value = 0.25
    nt.links.new(n.outputs["Fac"], r.inputs["Value"])
    a = nt.nodes.new("ShaderNodeMath")
    a.operation = "MULTIPLY"
    nt.links.new(at.outputs["Fac"], a.inputs[0])
    nt.links.new(r.outputs[0], a.inputs[1])
    tr = nt.nodes.new("ShaderNodeBsdfTransparent")
    mix = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(a.outputs[0], mix.inputs[0])
    nt.links.new(tr.outputs[0], mix.inputs[1])
    nt.links.new(p.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], nt.nodes["Material Output"].inputs[0])
    return m


def mat_mist(strength=0.5):
    """A soft ball of mist with no volume: opaque-ish at the centre, gone at the silhouette."""
    m = bpy.data.materials.new("mist")
    m.use_nodes = True
    nt = m.node_tree
    p = nt.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (1, 0.97, 0.93, 1)
    p.inputs["Roughness"].default_value = 1.0
    p.inputs["Specular IOR Level"].default_value = 0.0
    p.inputs["Emission Color"].default_value = (1.0, 0.84, 0.66, 1)
    p.inputs["Emission Strength"].default_value = 0.4
    lw = nt.nodes.new("ShaderNodeLayerWeight")
    lw.inputs["Blend"].default_value = 0.5
    inv = nt.nodes.new("ShaderNodeMath")
    inv.operation = "SUBTRACT"
    inv.inputs[0].default_value = 1.0
    nt.links.new(lw.outputs["Facing"], inv.inputs[1])
    pw = nt.nodes.new("ShaderNodeMath")
    pw.operation = "POWER"
    pw.inputs[1].default_value = 2.2
    nt.links.new(inv.outputs[0], pw.inputs[0])
    tc = nt.nodes.new("ShaderNodeTexCoord")
    n = nt.nodes.new("ShaderNodeTexNoise")
    n.inputs["Scale"].default_value = 2.6
    n.inputs["Detail"].default_value = 5
    nt.links.new(tc.outputs["Object"], n.inputs["Vector"])
    nr = nt.nodes.new("ShaderNodeMapRange")
    nr.inputs["From Min"].default_value = 0.35
    nr.inputs["From Max"].default_value = 0.68
    nt.links.new(n.outputs["Fac"], nr.inputs["Value"])
    a = nt.nodes.new("ShaderNodeMath")
    a.operation = "MULTIPLY"
    nt.links.new(pw.outputs[0], a.inputs[0])
    nt.links.new(nr.outputs[0], a.inputs[1])
    a2 = nt.nodes.new("ShaderNodeMath")
    a2.operation = "MULTIPLY"
    a2.inputs[1].default_value = strength
    nt.links.new(a.outputs[0], a2.inputs[0])
    tr = nt.nodes.new("ShaderNodeBsdfTransparent")
    mix = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(a2.outputs[0], mix.inputs[0])
    nt.links.new(tr.outputs[0], mix.inputs[1])
    nt.links.new(p.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], nt.nodes["Material Output"].inputs[0])
    return m


def mat_glow(name, col, k=1.0, edge=0.75):
    """Additive light that lives in the air, fading along the attribute 'fade'."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.remove(nt.nodes["Principled BSDF"])
    at = nt.nodes.new("ShaderNodeAttribute")
    at.attribute_name = "fade"
    lw = nt.nodes.new("ShaderNodeLayerWeight")
    lw.inputs["Blend"].default_value = 0.5
    e = nt.nodes.new("ShaderNodeMapRange")
    e.inputs["To Min"].default_value = 1.0 - edge
    e.inputs["To Max"].default_value = 1.0
    nt.links.new(lw.outputs["Facing"], e.inputs["Value"])
    a = nt.nodes.new("ShaderNodeMath")
    a.operation = "MULTIPLY"
    nt.links.new(at.outputs["Fac"], a.inputs[0])
    nt.links.new(e.outputs[0], a.inputs[1])
    a2 = nt.nodes.new("ShaderNodeMath")
    a2.operation = "MULTIPLY"
    a2.inputs[1].default_value = k
    nt.links.new(a.outputs[0], a2.inputs[0])
    em = nt.nodes.new("ShaderNodeEmission")
    em.inputs["Color"].default_value = (*col, 1)
    nt.links.new(a2.outputs[0], em.inputs["Strength"])
    tr = nt.nodes.new("ShaderNodeBsdfTransparent")
    ad = nt.nodes.new("ShaderNodeAddShader")
    nt.links.new(tr.outputs[0], ad.inputs[0])
    nt.links.new(em.outputs[0], ad.inputs[1])
    nt.links.new(ad.outputs[0], nt.nodes["Material Output"].inputs[0])
    return m


def mat_thin_glass(name="glass_thin", tint=(0.86, 0.97, 1.0)):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.remove(nt.nodes["Principled BSDF"])
    lw = nt.nodes.new("ShaderNodeLayerWeight")
    lw.inputs["Blend"].default_value = 0.36
    tr = nt.nodes.new("ShaderNodeBsdfTransparent")
    tr.inputs["Color"].default_value = (*tint, 1)
    gl = nt.nodes.new("ShaderNodeBsdfAnisotropic")
    gl.inputs["Roughness"].default_value = 0.05
    mix = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(lw.outputs["Fresnel"], mix.inputs[0])
    nt.links.new(tr.outputs[0], mix.inputs[1])
    nt.links.new(gl.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], nt.nodes["Material Output"].inputs[0])
    return m


def mat_found_volume(col):
    m = bpy.data.materials.new("found_vol")
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.remove(nt.nodes["Principled BSDF"])
    v = nt.nodes.new("ShaderNodeVolumePrincipled")
    v.inputs["Color"].default_value = (*col, 1)
    tc = nt.nodes.new("ShaderNodeTexCoord")
    grad = nt.nodes.new("ShaderNodeTexGradient")
    grad.gradient_type = "SPHERICAL"
    nt.links.new(tc.outputs["Object"], grad.inputs["Vector"])
    n = nt.nodes.new("ShaderNodeTexNoise")
    n.inputs["Scale"].default_value = 2.2
    n.inputs["Detail"].default_value = 5
    nt.links.new(tc.outputs["Object"], n.inputs["Vector"])
    nr = nt.nodes.new("ShaderNodeMapRange")
    nr.inputs["From Min"].default_value = 0.35
    nr.inputs["From Max"].default_value = 0.68
    nt.links.new(n.outputs["Fac"], nr.inputs["Value"])
    a = nt.nodes.new("ShaderNodeMath")
    a.operation = "MULTIPLY"
    nt.links.new(grad.outputs["Fac"], a.inputs[0])
    nt.links.new(nr.outputs[0], a.inputs[1])
    d = nt.nodes.new("ShaderNodeMath")
    d.operation = "MULTIPLY"
    d.inputs[1].default_value = 0.5
    nt.links.new(a.outputs[0], d.inputs[0])
    nt.links.new(d.outputs[0], v.inputs["Density"])
    e = nt.nodes.new("ShaderNodeMath")
    e.operation = "MULTIPLY"
    e.inputs[1].default_value = 1.1
    nt.links.new(a.outputs[0], e.inputs[0])
    v.inputs["Emission Color"].default_value = (*col, 1)
    nt.links.new(e.outputs[0], v.inputs["Emission Strength"])
    nt.links.new(v.outputs[0], nt.nodes["Material Output"].inputs["Volume"])
    return m


CYAN = (0.0, 0.58, 1.0)
GOLD_LIGHT = (1.0, 0.66, 0.3)
MATS = dict(
    rock=mat_rock(), grass=mat_grass(), cloud=mat_cloud(), fall=mat_fall(), fall_b=mat_fall("fall_b"), fall_c=mat_fall("fall_c"), fall_d=mat_fall("fall_d"), mist=mat_mist(),
    glass_thin=mat_thin_glass(),
    leaf_green=mat_leaf("leaf_green", (0.07, 0.16, 0.035), (0.22, 0.32, 0.06)),
    leaf_gold=mat_leaf("leaf_gold", (0.5, 0.26, 0.03), (0.92, 0.6, 0.1)),
    leaf_olive=mat_leaf("leaf_olive", (0.16, 0.2, 0.04), (0.42, 0.4, 0.08)),
    leaf_rust=mat_leaf("leaf_rust", (0.4, 0.12, 0.03), (0.75, 0.3, 0.06)),
    ceramic=pbsdf("ceramic", (0.7, 0.64, 0.55), 0.36, coat=0.45, coat_rough=0.12),
    ceramic2=pbsdf("ceramic2", (0.55, 0.59, 0.6), 0.4, coat=0.3),
    stone=pbsdf("stone", (0.42, 0.37, 0.32), 0.82),
    paver=pbsdf("paver", (0.6, 0.53, 0.44), 0.75),
    gold=pbsdf("gold", (1.0, 0.6, 0.15), 0.24, metal=1.0),
    brass=pbsdf("brass", (0.62, 0.42, 0.17), 0.34, metal=1.0),
    dark=pbsdf("dark", (0.03, 0.034, 0.045), 0.34, metal=0.85),
    rail=pbsdf("rail", (0.06, 0.06, 0.07), 0.45, metal=0.7),
    glass=pbsdf("glass", (0.03, 0.07, 0.09), 0.08, metal=0.6, coat=1.0),
    pv=pbsdf("pv", (0.012, 0.035, 0.11), 0.16, coat=1.0),
    water=pbsdf("water", (0.05, 0.28, 0.34), 0.05, coat=1.0),
    bark=pbsdf("bark", (0.09, 0.06, 0.045), 0.85),
    crate=pbsdf("crate", (0.5, 0.42, 0.3), 0.55),
    crate2=pbsdf("crate2", (0.2, 0.3, 0.33), 0.5),
    rubber=pbsdf("rubber", (0.012, 0.012, 0.014), 0.72),
    vine=pbsdf("vine", (0.06, 0.13, 0.03), 0.8),
    led_off=pbsdf("led_off", (0.03, 0.03, 0.035), 0.25),
    window=pbsdf("window", (0, 0, 0), 0.2, emis=(1.0, 0.56, 0.2), emis_str=3.4),
    lamp=pbsdf("lamp", (0, 0, 0), 0.3, emis=(1.0, 0.56, 0.2), emis_str=3.4),
    eye=pbsdf("eye", mascots.EYE_MATERIAL["base"], mascots.EYE_MATERIAL["roughness"], coat=mascots.EYE_MATERIAL["coat"], coat_rough=mascots.EYE_MATERIAL["coat_roughness"]),
    field=pbsdf("field", (0, 0, 0), 0.3, emis=CYAN, emis_str=3.0),
    field_node=pbsdf("field_node", (0, 0, 0), 0.3, emis=(0.2, 0.85, 1.0), emis_str=3.4),
    orb=pbsdf("orb", (0, 0, 0), 0.2, emis=(1.0, 0.58, 0.18), emis_str=3.2),
    flower_gold=pbsdf("flower_gold", (1.0, 0.62, 0.05), 0.5, emis=(1.0, 0.6, 0.08), emis_str=0.25),
    flower_pink=pbsdf("flower_pink", (0.9, 0.3, 0.42), 0.5),
    rotor=pbsdf("rotor", (0.3, 0.32, 0.36), 0.3, metal=0.5),
    field_glow=mat_glow("field_glow", CYAN, 0.8),
    grain=pbsdf("grain", (0.62, 0.3, 0.008), 0.42, emis=(1.0, 0.42, 0.008), emis_str=0.85),
    grain2=pbsdf("grain2", (0.7, 0.34, 0.01), 0.42, emis=(1.0, 0.46, 0.01), emis_str=1.4),
    # The same two looks again for the standing crop only, so wind bends the heads and never the grain lying in a basket.
    head=pbsdf("head", (0.62, 0.3, 0.008), 0.42, emis=(1.0, 0.42, 0.008), emis_str=0.85),
    head2=pbsdf("head2", (0.7, 0.34, 0.01), 0.42, emis=(1.0, 0.46, 0.01), emis_str=1.4),
    stem=pbsdf("stem", (0.5, 0.3, 0.05), 0.6, emis=(1.0, 0.34, 0.02), emis_str=0.2),
    stubble=pbsdf("stubble", (0.72, 0.5, 0.18), 0.8),
    soil=pbsdf("soil", (0.12, 0.075, 0.045), 0.95),
    wicker=pbsdf("wicker", (0.46, 0.26, 0.09), 0.62),
    wicker2=pbsdf("wicker2", (0.66, 0.42, 0.15), 0.55),
    wood=pbsdf("wood", (0.27, 0.15, 0.075), 0.58),
    sail=pbsdf("sail", (1.0, 0.93, 0.8), 0.7, sss=0.2, sss_scale=0.1, emis=(1.0, 0.72, 0.42), emis_str=0.2),
    juice=pbsdf("juice", (0.9, 0.42, 0.01), 0.2, emis=(1.0, 0.44, 0.01), emis_str=1.8),
    juice_deep=pbsdf("juice_deep", (0.55, 0.22, 0.004), 0.2, emis=(1.0, 0.38, 0.006), emis_str=0.8),
    jar_gold=pbsdf("jar_gold", (0.7, 0.32, 0.006), 0.14, emis=(1.0, 0.4, 0.006), emis_str=0.7, coat=1.0),
    beacon=pbsdf("beacon", (0.6, 0.28, 0.01), 0.2, emis=(1.0, 0.46, 0.02), emis_str=2.0),
    trail=pbsdf("trail", (0, 0, 0), 0.4, emis=(1.0, 0.44, 0.06), emis_str=1.4),
    stud=pbsdf("stud", (0, 0, 0), 0.4, emis=(1.0, 0.44, 0.06), emis_str=2.4)
    ,steel=pbsdf("steel", (0.86, 0.86, 0.84), 0.22, metal=1.0, coat=0.5),
)


MATS.update(mascots.prop_materials(pbsdf, size=1.0))


def grime(m, amount=0.5, stretch=(7, 7, 1.1)):
    """Streaks and staining, multiplied into the base colour."""
    nt = m.node_tree
    p = nt.nodes["Principled BSDF"]
    base = tuple(p.inputs["Base Color"].default_value)
    tc = nt.nodes.new("ShaderNodeTexCoord")
    mp = nt.nodes.new("ShaderNodeMapping")
    mp.inputs["Scale"].default_value = stretch
    nt.links.new(tc.outputs["Object"], mp.inputs["Vector"])
    n = nt.nodes.new("ShaderNodeTexNoise")
    n.inputs["Scale"].default_value = 3.2
    n.inputs["Detail"].default_value = 8
    n.inputs["Roughness"].default_value = 0.62
    nt.links.new(mp.outputs[0], n.inputs["Vector"])
    r = nt.nodes.new("ShaderNodeValToRGB")
    g = 1 - amount
    r.color_ramp.elements[0].position = 0.36
    r.color_ramp.elements[0].color = (g, g * 0.97, g * 0.93, 1)
    r.color_ramp.elements[1].position = 0.64
    nt.links.new(n.outputs["Fac"], r.inputs["Fac"])
    mx = nt.nodes.new("ShaderNodeMix")
    mx.data_type = "RGBA"
    mx.blend_type = "MULTIPLY"
    mx.inputs["Factor"].default_value = 1.0
    mx.inputs["A"].default_value = base
    nt.links.new(r.outputs["Color"], mx.inputs["B"])
    nt.links.new(mx.outputs["Result"], p.inputs["Base Color"])


for _name, _amt in (("ceramic", 0.22), ("ceramic2", 0.3), ("stone", 0.5), ("paver", 0.4), ("brass", 0.3), ("crate", 0.4), ("crate2", 0.4)):
    grime(MATS[_name], _amt)


# ---------- geometry ----------
class Geo:
    def __init__(self):
        self.d = {}

    def add(self, mat, V, F, S):
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


CUR = {}
G = Geo()
_box = {}
EX = []     # keep-clear circles on the current disc: (x, y, r)
TURF_MASK = None     # worked ground on the current disc, where no grass grows
RING_K = 1.0


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


def torus(mat, c, R, r, seg=72, tseg=10, rx=0.0, rz=0.0, ry=0.0):
    V, F = [], []
    for i in range(seg):
        t = 2 * math.pi * i / seg
        for j in range(tseg):
            p = 2 * math.pi * j / tseg
            V.append(((R + r * math.cos(p)) * math.cos(t), (R + r * math.cos(p)) * math.sin(t), r * math.sin(p)))
    for i in range(seg):
        i2 = (i + 1) % seg
        for j in range(tseg):
            j2 = (j + 1) % tseg
            F.append((i * tseg + j, i2 * tseg + j, i2 * tseg + j2, i * tseg + j2))
    G.add(mat, np.array(V) @ _rot(rz, rx, ry).T + np.asarray(c), F, [True] * len(F))


def loft(mat, rings, closed=True, smooth=True):
    rings = [np.asarray(r, float) for r in rings]
    n, m = len(rings[0]), len(rings)
    F = []
    for j in range(m - 1):
        for i in range(n if closed else n - 1):
            a, b = j * n + i, j * n + (i + 1) % n
            F.append((a, b, b + n, a + n))
    G.add(mat, np.concatenate(rings), F, [smooth] * len(F))


def mesh_obj(name, V, F, mat, attr=None, attr_name="moss", smooth=True):
    me = bpy.data.meshes.new(name)
    me.from_pydata(V.tolist() if hasattr(V, "tolist") else V, [], F)
    if smooth:
        me.polygons.foreach_set("use_smooth", [True] * len(me.polygons))
    if attr is not None:
        a = me.attributes.new(attr_name, "FLOAT", "POINT")
        a.data.foreach_set("value", attr)
    me.update()
    me.materials.append(MATS[mat])
    o = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(o)
    return o


def point(p, e, col=(1.0, 0.62, 0.3), r=0.03):
    l = bpy.data.lights.new("pt", "POINT")
    l.energy = e
    l.color = col
    l.shadow_soft_size = r
    o = bpy.data.objects.new("pt", l)
    o.location = tuple(float(v) for v in p)
    bpy.context.collection.objects.link(o)


def spot(p, e, col, size=70.0, blend=1.0, r=0.3, rot=(0.0, 0.0, 0.0)):
    l = bpy.data.lights.new("sp", "SPOT")
    l.energy = e
    l.color = col
    l.spot_size = math.radians(size)
    l.spot_blend = blend
    l.shadow_soft_size = r
    o = bpy.data.objects.new("sp", l)
    o.location = tuple(float(v) for v in p)
    o.rotation_euler = rot
    bpy.context.collection.objects.link(o)


_ico = {}


def ico(sub):
    if sub not in _ico:
        bm = bmesh.new()
        bmesh.ops.create_icosphere(bm, subdivisions=sub, radius=1.0)
        V = np.array([v.co[:] for v in bm.verts])
        idx = {v: i for i, v in enumerate(bm.verts)}
        F = [tuple(idx[v] for v in f.verts) for f in bm.faces]
        bm.free()
        _ico[sub] = (V, F)
    return _ico[sub]


def blob(mat, c, r, sq=(1, 1, 1), n1=0.3, n2=0.12, sub=3):
    V0, F0 = ico(sub)
    off = Vector((random.uniform(0, 60), random.uniform(0, 60), 0))
    q = np.array([v * (1 + n1 * noise.noise(Vector(v) * 1.5 + off) + n2 * noise.noise(Vector(v) * 4.5 + off)) for v in V0])
    G.add(mat, q * r * np.array(sq) + np.asarray(c), F0, [True] * len(F0))


# ---------- the floating disc ----------
SEED = 0.0
RIM = []
BVH = None


def top_h(x, y):
    r = math.hypot(x, y)
    n = noise.fractal(Vector((x * 0.5 + SEED, y * 0.5, 1.7)), 1.0, 2.0, 4)
    m = noise.noise(Vector((x * 1.6 + SEED, y * 1.6, 4.2)))
    k = min(max((r - 1.5) / 1.2, 0.0), 1.0)
    return 0.02 * n + k * (0.15 * n + 0.02 * m)


def rim_radius(a):
    return RIM[int((a % (2 * math.pi)) / (2 * math.pi) * len(RIM)) % len(RIM)]


def build_disc(seed, R, D, na=560, nt=40, nl=10, nu=190):
    global SEED, RIM, BVH
    SEED = seed * 1.37
    s = SEED
    P, M = [], []
    RIM = []
    for i in range(na):
        a = 2 * math.pi * i / na
        ca, sa = math.cos(a), math.sin(a)
        Ra = R * (1 + 0.035 * math.sin(3 * a + s) + 0.018 * math.sin(5 * a + 2.1 * s) + 0.01 * math.sin(11 * a + 0.7 * s) + 0.014 * noise.noise(Vector((ca * 3 + s, sa * 3, 0.3))))
        RIM.append(Ra)
        Da = D * (0.9 + 0.46 * noise.fractal(Vector((ca * 1.1 + s, sa * 1.1, 5.0)), 1.0, 2.0, 3))
        ox = 0.34 * R * noise.noise(Vector((s, 1.5, 2.0)))
        oy = 0.34 * R * noise.noise(Vector((s, 3.5, 7.0)))
        zr = top_h(Ra * 0.96 * ca, Ra * 0.96 * sa)
        for j in range(nt):
            t = j / (nt - 1)
            r = 0.02 + t * (Ra * 0.96 - 0.02)
            x, y = r * ca, r * sa
            P.append((x, y, top_h(x, y)))
            M.append(1.0)
        for j in range(1, nl + 1):
            ph = j / nl * math.pi / 2
            r = Ra * (0.96 + 0.045 * math.sin(ph))
            P.append((r * ca, r * sa, zr - 0.22 * (1 - math.cos(ph))))
            M.append(1.0 - 0.62 * j / nl)
        for j in range(1, nu + 1):
            u = j / nu
            d = 0.22 + (Da - 0.22) * u ** 1.1
            g = (1 - u ** 1.75) ** 0.6
            rr = Ra * 1.005 * g
            cx, cy = ox * u ** 1.4, oy * u ** 1.4
            v = Vector((rr * ca, rr * sa, -d))
            n1 = noise.fractal(v * 0.62 + Vector((3.1 + s, 7.7, 1.3)), 1.0, 2.1, 5)
            n2 = noise.ridged_multi_fractal(Vector((v.x * 1.9 + s, v.y * 1.9, v.z * 0.35)), 1.0, 2.2, 4, 1.0, 2.0)
            n4 = noise.fractal(v * 6.5, 1.0, 2.1, 3)
            strata = (d * 2.3 + n1 * 2.4) % 1.0
            blk = 0.5 + 0.9 * noise.noise(Vector((ca * 3.4 + s, sa * 3.4, d * 0.9)))
            e = min(u * 6, 1.0)
            sc = 1 + e * (0.2 * n1 + 0.03 * (n2 - 0.7) - 0.06 * strata * max(blk, 0.0) * (1 - u) ** 0.8 + 0.014 * n4)
            P.append((cx + rr * sc * ca, cy + rr * sc * sa, zr - d + e * (0.1 * n1 + 0.03 * n4)))
            M.append(max(0.38 - d * 0.5, 0.0))
    ring = nt + nl + nu
    F = []
    for i in range(na):
        i2 = (i + 1) % na
        for j in range(ring - 1):
            F.append((i * ring + j, i * ring + j + 1, i2 * ring + j + 1, i2 * ring + j))
    P = np.array(P)
    M = np.array(M)
    me = bpy.data.meshes.new("tmp")
    me.from_pydata(P.tolist(), [], F)
    me.update()
    N = np.zeros((len(P), 3))
    me.vertices.foreach_get("normal", N.ravel())
    bpy.data.meshes.remove(me)
    # moss also settles on ledges high on the rock
    idx = np.arange(len(P)) % ring
    depth = np.maximum(-P[:, 2], 0)
    ledge = np.clip((N[:, 2] - 0.58) / 0.22, 0, 1) * np.clip(1.0 - depth / 2.0, 0, 1) * 0.62
    moss = np.where(idx < nt, 1.0, np.maximum(M, ledge))
    mesh_obj("rock", P, F, "rock", attr=moss.astype(np.float32), attr_name="moss")
    BVH = BVHTree.FromPolygons(P.tolist(), F)


def gz(x, y):
    return top_h(x, y)


def boulders(places, moss=0.55):
    """Displaced rocks in the rock material. places: (x, y, z, size)."""
    V0, F0 = ico(3)
    Vs, Fs, As, n = [], [], [], 0
    for x, y, z, s_b in places:
        off = Vector((random.uniform(0, 50), random.uniform(0, 50), 0))
        q = np.array([v * (1 + 0.46 * noise.noise(Vector(v) * 1.5 + off) + 0.1 * noise.noise(Vector(v) * 5.0 + off)) for v in V0])
        sq = np.array((random.uniform(0.75, 1.4), random.uniform(0.75, 1.4), random.uniform(0.5, 0.95)))
        w = (q * s_b * sq) @ _rot(random.uniform(0, 6.28)).T + np.array((x, y, z + s_b * 0.1))
        Vs.append(w)
        Fs.extend([tuple(i + n for i in f) for f in F0])
        As.append(np.clip((q[:, 2] - 0.3) / 0.4, 0, 1) * moss)
        n += len(q)
    if Vs:
        mesh_obj("boulders", np.concatenate(Vs), Fs, "rock", attr=np.concatenate(As).astype(np.float32), attr_name="moss")


# ---------- turf: real short grass and little flowers, one mesh per disc ----------
def build_turf(R, count, seed):
    rng = np.random.default_rng(seed)
    r = R * 1.05 * np.sqrt(rng.random(count))
    a = rng.random(count) * 2 * np.pi
    x, y = r * np.cos(a), r * np.sin(a)
    rim_a = np.array(RIM)
    keep = r < rim_a[(a / (2 * np.pi) * len(rim_a)).astype(int) % len(rim_a)] * 0.955
    for ex, ey, er in EX:
        keep &= (x - ex) ** 2 + (y - ey) ** 2 > er * er
    if TURF_MASK is not None:
        keep &= ~TURF_MASK(x, y)
    x, y = x[keep], y[keep]
    n = len(x)
    # height grid sampled once, bilinear per blade
    g = 96
    gx = np.linspace(-R * 1.08, R * 1.08, g)
    H = np.array([[top_h(float(u), float(v)) for u in gx] for v in gx])
    T = np.array([[noise.fractal(Vector((float(u) * 1.2 + seed, float(v) * 1.2, 2.0)), 1.0, 2.0, 3) for u in gx] for v in gx])
    F_ = np.array([[noise.noise(Vector((float(u) * 0.8 + seed, float(v) * 0.8, 6.0))) for u in gx] for v in gx])
    fx = (x - gx[0]) / (gx[1] - gx[0])
    fy = (y - gx[0]) / (gx[1] - gx[0])
    ix, iy = np.clip(fx.astype(int), 0, g - 2), np.clip(fy.astype(int), 0, g - 2)
    wx, wy = fx - ix, fy - iy

    def bil(A):
        return A[iy, ix] * (1 - wx) * (1 - wy) + A[iy, ix + 1] * wx * (1 - wy) + A[iy + 1, ix] * (1 - wx) * wy + A[iy + 1, ix + 1] * wx * wy

    z = bil(H)
    tall = np.clip(0.75 + 0.9 * bil(T), 0.35, 1.7)
    bl = rng.uniform(0.045, 0.1, n) * tall
    w = rng.uniform(0.018, 0.03, n)
    ang = rng.random(n) * 2 * np.pi
    ca, sa = np.cos(ang), np.sin(ang)
    lean = rng.uniform(0.0, 0.5, n) * bl
    la = rng.random(n) * 2 * np.pi
    V = np.zeros((n * 3, 3))
    V[0::3] = np.stack((x - ca * w / 2, y - sa * w / 2, z - 0.01), axis=1)
    V[1::3] = np.stack((x + ca * w / 2, y + sa * w / 2, z - 0.01), axis=1)
    V[2::3] = np.stack((x + np.cos(la) * lean, y + np.sin(la) * lean, z + bl), axis=1)
    A = np.zeros(n * 3, dtype=np.float32)
    A[2::3] = 1.0
    A[0::3] = A[1::3] = rng.uniform(0.0, 0.25, n)
    F = np.arange(n * 3).reshape(-1, 3).tolist()
    mesh_obj("turf", V, F, "grass", attr=A, attr_name="tip", smooth=False)
    # flowers in drifts
    fl = bil(F_)
    pick = (fl > 0.2) & (rng.random(n) < 0.09)
    pick2 = (fl < -0.32) & (rng.random(n) < 0.05)
    for mask, mname, name in ((pick, "flower_gold", "fl_g"), (pick2, "flower_pink", "fl_p")):
        m = int(mask.sum())
        if m == 0:
            continue
        cx, cy, cz = x[mask], y[mask], z[mask] + bl[mask] * 1.0
        s = rng.uniform(0.012, 0.024, m)
        Vf = np.zeros((m * 4, 3))
        Vf[0::4] = np.stack((cx - s, cy, cz), axis=1)
        Vf[1::4] = np.stack((cx, cy - s, cz + s * 0.3), axis=1)
        Vf[2::4] = np.stack((cx + s, cy, cz), axis=1)
        Vf[3::4] = np.stack((cx, cy + s, cz + s * 0.3), axis=1)
        mesh_obj(name, Vf, np.arange(m * 4).reshape(-1, 4).tolist(), mname, smooth=False)


# ---------- the bots: the body shapes from the brand art ----------
def bot(c, s, shape="squircle", facing=math.radians(18), tool=None, side=None, pitch=math.radians(-7)):
    base = (c[0], c[1], c[2] - 0.47 * s)
    if PT.ON:
        PT.bot(CURCFG["key"], to_world(CURCFG, base), s * CURCFG["scale"], yaw=facing + CURCFG["rz"], shape=shape, tool=tool)
        return
    m = mascots.placed_mesh(shape, size=s, base=base, facing=facing, pitch=pitch)
    G.add("bot", m["body_v"], m["body_f"], [True] * len(m["body_f"]))
    G.add("eye", m["eye_v"], m["eye_f"], [True] * len(m["eye_f"]))
    if tool:
        for part in mascots.placed_prop(tool, shape=shape, size=s, base=base, facing=facing, pitch=pitch, side=side):
            G.add(part["mat"], part["v"], part["f"], [True] * len(part["f"]))


def bot_mats(key, col, state, size):
    m_ = max(col)
    c_ = tuple((x / m_) ** 1.7 for x in col)
    if state == "main":
        c_ = (1.0, 0.6, 0.27)    # the white lead's building lights run warm so they do not bleach
    hot = tuple(x * 0.88 + 0.12 for x in c_)
    k = dict(idle=0.55, working=1.0, found=1.6, done=0.85, main=0.62)[state]
    names = dict(led_on=f"led_on_{key}", led_dim=f"led_dim_{key}", led_hot=f"led_hot_{key}", bot=f"bot_{key}", accent=f"accent_{key}", beam=f"beam_{key}")
    MATS[names["led_on"]] = pbsdf(names["led_on"], (0, 0, 0), 0.2, emis=c_, emis_str=1.5 * k, coat=1.0)
    MATS[names["led_dim"]] = pbsdf(names["led_dim"], (0, 0, 0), 0.4, emis=c_, emis_str=0.6 * k)
    MATS[names["led_hot"]] = pbsdf(names["led_hot"], (0, 0, 0), 0.4, emis=hot, emis_str=2.8 * k)
    _sat = col if state == "main" else tuple(m_ * (x / m_) ** 1.35 for x in col)
    MATS[names["bot"]] = pbsdf(names["bot"], _sat, mascots.GLOSSY["roughness"], coat=mascots.GLOSSY["coat"], coat_rough=mascots.GLOSSY["coat_roughness"], sss=mascots.GLOSSY["sss"], sss_scale=mascots.GLOSSY["sss_scale"] * size)
    MATS[names["accent"]] = pbsdf(names["accent"], tuple(0.85 * v for v in col), 0.3, coat=0.8)
    MATS[names["beam"]] = mat_glow(names["beam"], c_, 0.9, edge=0.5)
    if state == "found":
        MATS["field_flare"] = pbsdf("field_flare", (0, 0, 0), 0.3, emis=tuple(v * 0.8 + 0.2 for v in c_), emis_str=9)
        MATS["found_vol"] = mat_found_volume(c_)
        names["field"] = "field_flare"
        names["field_node"] = "field_flare"
        names["field_glow"] = names["beam"]
    return names, c_


# ---------- building blocks ----------
def lit_mat(v):
    return "led_on" if v > -0.3 else "glass"


def plinth(x, y, r, h=0.14, mat="stone", seg=64):
    lathe(mat, (x, y, 0), [(r + 0.05, -0.25), (r + 0.05, h * 0.7), (r, h), (0.001, h)], seg=seg)


def collar(x, y, z, r, t=0.02, w=0.03, mat="gold", seg=56):
    lathe(mat, (x, y, z), [(r - 0.01, -t), (r + w, -t * 0.7), (r + w, t * 0.7), (r - 0.01, t), (r - 0.01, -t)], seg=seg)


def pixel_wall(x, y, z0, z1, r, rows, cols, a0=math.pi - 0.7, a1=2 * math.pi + 0.7, r_top=None):
    """Panes of real glass on a round wall, the side facing the camera. Some are lit in the bot's colour,
    in calm patches. The wall showing between them is the mullion."""
    rows, cols = max(1, int(round(rows * 0.72))), max(3, int(round(cols * 0.72)))
    sd = random.uniform(0, 90)
    rh = (z1 - z0) / rows
    r_top = r if r_top is None else r_top
    for j in range(rows):
        z = z0 + (j + 0.5) * rh
        rr = r + (r_top - r) * (j + 0.5) / rows
        for i in range(cols):
            a = a0 + (a1 - a0) * (i + 0.5) / cols
            v = noise.noise(Vector((i * 0.42 + sd, j * 0.46, sd)))
            box(lit_mat(v), (x + math.cos(a) * (rr + 0.003), y + math.sin(a) * (rr + 0.003), z), (0.012, (a1 - a0) * rr / cols * 0.84, rh * 0.8), r=0.0, rz=a)


def window_band(x, y, z, r, h, n, a0=math.pi - 0.7, a1=2 * math.pi + 0.7, mat="window"):
    for i in range(n):
        a = a0 + (a1 - a0) * (i + 0.5) / n
        box(mat if random.random() > 0.2 else "glass", (x + math.cos(a) * (r + 0.003), y + math.sin(a) * (r + 0.003), z), (0.012, (a1 - a0) * r / n * 0.6, h), r=0.0, rz=a)


def rail_ring(x, y, z, r, n=36, h=0.13, a0=0.0, a1=2 * math.pi):
    pts = []
    for i in range(n + 1):
        a = a0 + (a1 - a0) * i / n
        p = (x + r * math.cos(a), y + r * math.sin(a), z)
        cyl("rail", p, (p[0], p[1], z + h), 0.0055, seg=5, cap=False)
        pts.append((p[0], p[1], z + h))
    for p, q in zip(pts, pts[1:]):
        cyl("rail", p, q, 0.0045, seg=5, cap=False)


def lamp_post(x, y, h=0.42, light=0.0):
    z = gz(x, y)
    cyl("rail", (x, y, z - 0.02), (x, y, z + h), 0.009, seg=6)
    sphere("lamp", (x, y, z + h + 0.012), 0.017, seg=8, rings=5)
    if light:
        point((x, y, z + h), light)


def blade(hub, ang, L, root=0.055, chord=0.2, mat="ceramic"):
    hub = np.asarray(hub, float)
    along = np.array((math.cos(ang), 0.0, math.sin(ang)))
    side = np.array((-math.sin(ang), 0.0, math.cos(ang)))
    depth = np.array((0.0, 1.0, 0.0))
    secs = []
    N = 14
    for k in range(N + 1):
        t = k / N
        c = root + (chord - root) * min(t / 0.18, 1.0) ** 1.4 if t < 0.18 else chord * (1 - 0.86 * ((t - 0.18) / 0.82) ** 0.9)
        tw = 0.5 * (1 - t)
        p = hub + along * L * t + side * c * 0.22
        ring = []
        for q in range(8):
            a = 2 * math.pi * q / 8
            u, w = math.cos(a) * c * 0.5, math.sin(a) * max(c * 0.09, 0.008)
            ring.append(p + side * (u * math.cos(tw) - w * math.sin(tw)) + depth * (u * math.sin(tw) + w * math.cos(tw)))
        secs.append(ring)
    i0 = int(N * 0.8)
    loft(mat, secs[: i0 + 1])
    loft("accent", secs[i0: i0 + 2])
    loft(mat, secs[i0 + 1:])
    sphere("led_hot", hub + along * L, 0.022, seg=8, rings=5)


def turbine_unit(x, y, H, L, base_r=0.2, phase=0.4, z0=0.0):
    lathe("ceramic", (x, y, z0), [(base_r * 1.3, 0.0), (base_r, 0.25), (base_r * 0.72, H * 0.55), (base_r * 0.5, H)], seg=26)
    collar(x, y, z0 + 0.25, base_r, mat="brass", seg=26)
    hz = z0 + H + 0.07
    sphere("ceramic", (x, y + 0.08, hz), L * 0.11, seg=18, rings=12, sc=(0.8, 1.7, 0.8))
    hub = (x, y - L * 0.14, hz)
    sphere("gold", hub, L * 0.06, seg=14, rings=9, sc=(1, 1.3, 1))
    for k in range(3):
        blade(hub, phase + k * 2.0944, L, chord=L * 0.115, root=L * 0.03)


def tree(x, y, h=0.9, mat="leaf_green", kind=0, z=None):
    z = gz(x, y) if z is None else z
    cyl("bark", (x, y, z - 0.03), (x + random.uniform(-0.04, 0.04), y + random.uniform(-0.04, 0.04), z + h * 0.72), 0.022 + 0.018 * h, seg=7, r2=0.012 + 0.008 * h)
    if kind == 0:
        for _ in range(random.randint(3, 5)):
            ca, cr = random.uniform(0, 6.28), random.uniform(0, 0.14) * h
            blob(mat, (x + cr * math.cos(ca), y + cr * math.sin(ca), z + h * random.uniform(0.66, 0.95)), h * random.uniform(0.17, 0.3), sub=3)
    else:
        for _ in range(3):
            ca, cr = random.uniform(0, 6.28), random.uniform(0.05, 0.2) * h
            blob(mat, (x + cr * math.cos(ca), y + cr * math.sin(ca), z + h * random.uniform(0.82, 0.95)), h * 0.27, sq=(1.15, 1.15, 0.42), n1=0.22, sub=3)


def bush(x, y, r=0.12, mat="leaf_olive", z=None):
    z = gz(x, y) if z is None else z
    blob(mat, (x, y, z + r * 0.4), r, sq=(1.1, 1.1, 0.72), sub=2)


def drone(c, s=0.34, rz=0.0, light="led_hot"):
    c = np.asarray(c, float)
    sphere("ceramic", c, s * 0.34, seg=12, rings=7, sc=(1.25, 1.0, 0.55), rz=rz)
    sphere("dark", c - (0, 0, s * 0.1), s * 0.19, seg=8, rings=5, sc=(1, 1, 0.7))
    for i in range(4):
        a = rz + math.pi / 4 + i * math.pi / 2
        tip = c + np.array((math.cos(a) * s * 0.62, math.sin(a) * s * 0.62, s * 0.05))
        cyl("dark", c, tip, s * 0.028, seg=5, cap=False)
        cyl("dark", tip - (0, 0, s * 0.05), tip + (0, 0, s * 0.07), s * 0.04, seg=6)
        lathe("rotor", tip + (0, 0, s * 0.08), [(0.001, 0.0), (s * 0.27, 0.0)], seg=14)
    sphere(light, c - (0, 0, s * 0.2), s * 0.075, seg=8, rings=5)


def waterfall(a, R, length, width, seed):
    """Thin strands leaving the rim, widening and thinning out to nothing, then mist."""
    rnd = random.Random(seed)
    ca, sa = math.cos(a), math.sin(a)
    Ra = rim_radius(a)
    rim = np.array((Ra * 1.0 * ca, Ra * 1.0 * sa, top_h(Ra * 0.96 * ca, Ra * 0.96 * sa) - 0.03))
    out = np.array((ca, sa, 0.0))
    side = np.array((-sa, ca, 0.0))
    V, A = [], []
    F_parts = ([], [], [], [])
    N = 44
    n0 = 0
    for k in range(7):
        off = (k - 3) / 3 * width * 0.5 + rnd.uniform(-0.02, 0.02)
        wd = width * rnd.uniform(0.16, 0.34)
        ln = length * rnd.uniform(0.72, 1.0)
        sd = rnd.uniform(0, 40)
        for j in range(N + 1):
            t = j / N
            d = t * ln
            o2 = 0.05 + 0.3 * math.sqrt(max(d, 0)) * (0.8 + 0.25 * rnd.random() * 0)
            wob = 0.06 * t * noise.noise(Vector((sd, t * 3, 0.2)))
            p = rim + out * o2 + side * (off * (1 + 0.55 * t) + wob) + np.array((0, 0, -d))
            w = wd * (1 + 1.6 * t)
            V.append(p - side * w / 2)
            V.append(p + side * w / 2)
            fd = min(t / 0.03, 1.0) * (1 - min(max((t - 0.36) / 0.62, 0.0), 1.0)) ** 1.25
            A += [fd, fd]
        for j in range(N):
            b = n0 + j * 2
            part = 0 if j / N < 0.4 else 1 if j / N < 0.54 else 2 if j / N < 0.68 else 3
            F_parts[part].append((b, b + 1, b + 3, b + 2))
        n0 += (N + 1) * 2
    # One look in four parts: the motion field streams the sheet hard and lets go as the water thins, so the stream has no hard end.
    for part_, mname_ in enumerate(("fall", "fall_b", "fall_c", "fall_d")):
        mesh_obj(mname_, np.array(V), F_parts[part_], mname_, attr=np.array(A, dtype=np.float32), attr_name="fade")
    # The mist where it dissolves is live now (scene.js): stacked balls in the render read as hard circles.
    return rim


def stream(p0, a, width=0.09):
    """A brook from a small pool to the rim, then returns its keep-clear circles."""
    Ra = rim_radius(a)
    end = np.array((Ra * 0.985 * math.cos(a), Ra * 0.985 * math.sin(a)))
    p0 = np.asarray(p0, float)
    N = 28
    d = end - p0
    nrm = np.array((-d[1], d[0])) / (np.linalg.norm(d) + 1e-9)
    pts = []
    for i in range(N + 1):
        t = i / N
        q = p0 + d * t + nrm * 0.14 * math.sin(t * 5.5) * (1 - t * 0.6)
        pts.append(q)
    secs = []
    for i, q in enumerate(pts):
        z = gz(q[0], q[1]) + 0.016
        if i == N:
            z = top_h(Ra * 0.96 * math.cos(a), Ra * 0.96 * math.sin(a)) - 0.02
        w = width * (0.75 + 0.5 * i / N)
        secs.append([(q[0] - nrm[0] * w, q[1] - nrm[1] * w, z), (q[0] + nrm[0] * w, q[1] + nrm[1] * w, z)])
        EX.append((float(q[0]), float(q[1]), w * 1.25))
    loft("water", secs, closed=False, smooth=False)
    # stones along the banks
    places = []
    for i in range(0, N, 2):
        q = pts[i]
        s_ = random.choice((-1, 1))
        px, py = q[0] + nrm[0] * s_ * 0.13, q[1] + nrm[1] * s_ * 0.13
        places.append((float(px), float(py), gz(px, py), random.uniform(0.014, 0.04)))
    return places


def pool(x, y, r=0.34):
    z = gz(x, y)
    lathe("stone", (x, y, z), [(r + 0.07, -0.05), (r + 0.07, 0.03), (r + 0.01, 0.045), (r, 0.018)], seg=36)
    lathe("water", (x, y, z + 0.018), [(r + 0.01, 0.0), (0.001, 0.0)], seg=36)
    EX.append((x, y, r + 0.1))


# ---------- the lift: a cyan antigravity ring under every disc ----------
def shell(mat, prof, seg=72, c=(0, 0, 0)):
    V, F, A = [], [], []
    for r, z, fd in prof:
        for i in range(seg):
            t = 2 * math.pi * i / seg
            V.append((c[0] + r * math.cos(t), c[1] + r * math.sin(t), c[2] + z))
            A.append(fd)
    for j in range(len(prof) - 1):
        for i in range(seg):
            a, b = j * seg + i, j * seg + (i + 1) % seg
            F.append((a, b, b + seg, a + seg))
    return mesh_obj(mat + "_shell", np.array(V), F, CUR.get(mat, mat), attr=np.array(A, dtype=np.float32), attr_name="fade")


def grav_ring(R, D, zr, found, s_w):
    rr = R * 0.7
    k = 3.0 if found else 1.0
    prof = [(rr - 0.2, -0.075), (rr + 0.2, -0.075), (rr + 0.23, -0.02), (rr + 0.23, 0.05), (rr + 0.18, 0.09), (rr - 0.17, 0.09), (rr - 0.22, 0.04), (rr - 0.22, -0.035), (rr - 0.2, -0.075)]
    lathe("dark", (0, 0, zr), prof, seg=140)
    lathe("ceramic", (0, 0, zr), [(rr + 0.232, -0.012), (rr + 0.232, 0.042), (rr + 0.185, 0.093), (rr + 0.07, 0.096)], seg=140)
    lathe("field", (0, 0, zr), [(rr - 0.222, -0.03), (rr - 0.226, 0.035)], seg=140)
    lathe("field", (0, 0, zr - 0.077), [(rr - 0.13, 0.0), (rr + 0.13, 0.0)], seg=140)
    lathe("field", (0, 0, zr + 0.098), [(rr - 0.12, 0.0), (rr - 0.03, 0.0)], seg=140)
    for i in range(14):
        a = 2 * math.pi * i / 14
        cx, cy = rr * math.cos(a), rr * math.sin(a)
        box("gold" if i % 2 == 0 else "brass", (cx, cy, zr + 0.008), (0.56, 0.17, 0.215), r=0.025, rz=a)
        sphere("field_node", ((rr + 0.285) * math.cos(a), (rr + 0.285) * math.sin(a), zr + 0.008), 0.032, seg=8, rings=5)
    # the field itself: a soft sleeve of light around the rock. The wash going down is gone: its cone read as a hard panel against the sky.
    shell("field_glow", [(rr - 0.1, 0.05, 0.5 * k), (rr * 0.93, 0.7, 0.2 * k), (rr * 0.84, 1.5, 0.0)], c=(0, 0, zr))
    # light on the underside of the rock and down onto the clouds
    n = 7
    for i in range(n):
        a = 2 * math.pi * (i + 0.3) / n
        point((rr * 0.92 * math.cos(a), rr * 0.92 * math.sin(a), zr + 0.3), (20 if not found else 36) * RING_K, col=CYAN if not found else LEDCOL, r=0.35)
    spot((0, 0, zr - 0.4), (620 if not found else 3000) * RING_K, CYAN if not found else LEDCOL, size=72, r=1.0)


# ---------- parts of the line ----------
def beam(mat, a, b, w, h):
    """A square timber from a to b, with end caps."""
    a, b = np.asarray(a, float), np.asarray(b, float)
    d = (b - a) / (np.linalg.norm(b - a) + 1e-9)
    s = np.cross(d, (0.0, 0.0, 1.0))
    if np.linalg.norm(s) < 1e-4:
        s = np.array((1.0, 0.0, 0.0))
    s /= np.linalg.norm(s)
    u = np.cross(s, d)
    ring = lambda p: [p + s * w / 2 + u * h / 2, p - s * w / 2 + u * h / 2, p - s * w / 2 - u * h / 2, p + s * w / 2 - u * h / 2]
    V = np.array(ring(a) + ring(b))
    F = [(0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7), (3, 2, 1, 0), (4, 5, 6, 7)]
    G.add(mat, V, F, [False] * 6)


def basket(c, s=0.46, full=True, rz=0.0):
    """A woven basket. Full ones carry a mound of the glowing crop."""
    x, y, z = c
    lathe("wicker", (x, y, z), [(0.001, s * 0.02), (s * 0.3, 0.0), (s * 0.34, s * 0.03), (s * 0.47, s * 0.5), (s * 0.5, s * 0.62), (s * 0.46, s * 0.63), (s * 0.41, s * 0.5), (s * 0.1, s * 0.12)], seg=18)
    for t, r in ((0.16, 0.37), (0.3, 0.41), (0.44, 0.45)):
        torus("wicker2", (x, y, z + s * t), s * r, s * 0.017, seg=18, tseg=4)
    torus("wicker2", (x, y, z + s * 0.63), s * 0.5, s * 0.03, seg=20, tseg=5)
    if full:
        sphere("grain", (x, y, z + s * 0.62), s * 0.45, seg=12, rings=7, sc=(1.0, 1.0, 0.56))
        for _ in range(9):
            a, rd = random.uniform(0, 6.28), s * random.uniform(0.05, 0.42)
            sphere("grain2", (x + rd * math.cos(a), y + rd * math.sin(a), z + s * (0.82 - 0.5 * (rd / s) ** 2)), s * 0.08, seg=7, rings=4, sc=(0.8, 0.8, 1.5), rx=random.uniform(-0.6, 0.6), rz=random.uniform(0, 3))


def jar(c, s=0.34, filled=True):
    """A stoppered jar of pressed sun."""
    x, y, z = c
    lathe("jar_gold" if filled else "ceramic2", (x, y, z), [(0.001, 0.0), (s * 0.3, 0.0), (s * 0.38, s * 0.1), (s * 0.4, s * 0.55), (s * 0.3, s * 0.78), (s * 0.2, s * 0.84), (s * 0.2, s * 0.92), (0.001, s * 0.92)], seg=18)
    lathe("brass", (x, y, z + s * 0.84), [(s * 0.225, 0.0), (s * 0.225, s * 0.11), (0.001, s * 0.12)], seg=14)
    torus("brass", (x, y, z + s * 0.44), s * 0.405, s * 0.016, seg=18, tseg=4)


def landing_pad(x, y, r=0.5):
    z = gz(x, y)
    EX.append((x, y, r + 0.12))
    lathe("paver", (x, y, z), [(r + 0.08, -0.14), (r + 0.08, 0.03), (r + 0.04, 0.06), (r, 0.07), (0.001, 0.07)], seg=48)
    lathe("ceramic", (x, y, z + 0.07), [(r - 0.03, 0.0), (r - 0.05, 0.03), (0.001, 0.035)], seg=48)
    lathe("field", (x, y, z + 0.108), [(r * 0.62, 0.0), (r * 0.72, 0.0)], seg=48)
    collar(x, y, z + 0.045, r + 0.06, t=0.012, w=0.012, seg=48)
    return z + 0.105


def sail(hub, ang, L, w):
    """One sweep of the mill: a spar, a lattice and cream cloth on one side of it."""
    hub = np.asarray(hub, float)
    along = np.array((math.cos(ang), 0.0, math.sin(ang)))
    side = np.array((-math.sin(ang), 0.0, math.cos(ang)))
    dep = np.array((0.0, 1.0, 0.0))
    cyl("wood", hub, hub + along * L, 0.05, seg=8, r2=0.026)
    secs = []
    for t in np.linspace(0.17, 1.0, 11):
        p = hub + along * L * float(t)
        wd = w * (0.72 + 0.28 * float(t))
        row = []
        for u in np.linspace(0.0, 1.0, 5):
            row.append(p + side * (0.03 + wd * float(u)) + dep * (0.05 * math.sin(float(u) * math.pi) + 0.03))
        secs.append(row)
        cyl("wood", p + side * 0.02 - dep * 0.006, p + side * (wd + 0.05) - dep * 0.006, 0.012, seg=5, cap=False)
    loft("sail", secs, closed=False, smooth=True)
    cyl("wood", np.array(secs[0][-1]) - dep * 0.01, np.array(secs[-1][-1]) - dep * 0.01, 0.014, seg=5, cap=False)


def gear(c, R, teeth, w=0.07, mat="gold", rot=0.0):
    """A spur gear standing in the XZ plane, facing the camera."""
    x, y, z = c
    cyl(mat, (x, y - w / 2, z), (x, y + w / 2, z), R * 0.84, seg=teeth * 2)
    for i in range(teeth):
        a = rot + 2 * math.pi * i / teeth
        box(mat, (x + math.cos(a) * R * 0.92, y, z + math.sin(a) * R * 0.92), (R * 0.2, w, 2 * math.pi * R / teeth * 0.46), r=0.004, ry=-a)
    cyl("dark", (x, y - w / 2 - 0.012, z), (x, y + w / 2 + 0.012, z), R * 0.46, seg=18)
    cyl("brass", (x, y - w / 2 - 0.03, z), (x, y + w / 2 + 0.03, z), R * 0.16, seg=12)


def sickle(c, s=0.4, rz=0.0):
    """The harvester's floating blade."""
    c = np.asarray(c, float)
    ca, sa = math.cos(rz), math.sin(rz)
    pts = []
    for t in np.linspace(0.0, 1.0, 16):
        a = math.radians(-20 + 210 * float(t))
        q = np.array((math.cos(a) * s, 0.0, math.sin(a) * s * 0.92))
        pts.append(c + np.array((q[0] * ca, q[0] * sa, q[2])))
    for i, (p, q) in enumerate(zip(pts, pts[1:])):
        cyl("steel", p, q, s * (0.016 + 0.1 * math.sin(math.pi * (i + 0.5) / 15) ** 0.7), seg=6, cap=False, r2=s * (0.016 + 0.1 * math.sin(math.pi * (i + 1.5) / 15) ** 0.7))
    cyl("wood", pts[0], pts[0] - np.array((0.0, 0.0, s * 1.15)), s * 0.06, seg=7)
    cyl("gold", pts[0], pts[0] - np.array((0.0, 0.0, s * 0.16)), s * 0.085, seg=7)


def begin_world(cfg):
    global G, CUR, EX, LEDCOL, TURF_MASK, CURCFG
    CURCFG = cfg
    cfg["_before"] = set(bpy.data.objects)
    G = Geo()
    EX = []
    TURF_MASK = None
    CUR, c_ = bot_mats(cfg["key"], cfg["color"], cfg["state"], cfg["bs"])
    LEDCOL = c_
    random.seed(cfg["seed"])
    np.random.seed(cfg["seed"])
    n_ = 300 if cfg["station"] == "relay" else 540
    build_disc(float(cfg["seed"]), cfg["R"], cfg["D"], na=n_, nu=150 if cfg["station"] == "relay" else 190)


def end_world(cfg):
    G.build()
    root = bpy.data.objects.new("world_" + cfg["key"], None)
    bpy.context.collection.objects.link(root)
    s_w = cfg["scale"]
    root.location = (cfg["x"], cfg["y"], cfg["z"])
    root.rotation_euler = (cfg["tilt"], 0.0, cfg["rz"])
    root.scale = (s_w, s_w, s_w)
    for o in bpy.data.objects:
        if o not in cfg["_before"] and o is not root and o.parent is None:
            o.parent = root
    print("built", cfg["key"], flush=True)


def to_world(cfg, p):
    m = Matrix.Translation((cfg["x"], cfg["y"], cfg["z"])) @ Matrix.Rotation(cfg["rz"], 4, "Z") @ Matrix.Rotation(cfg["tilt"], 4, "X") @ Matrix.Scale(cfg["scale"], 4)
    return np.array(m @ Vector((float(p[0]), float(p[1]), float(p[2]))))


def spot_free(R, rmin, rmax, clear, a0=-math.pi, a1=math.pi, tries=70):
    for _ in range(tries):
        a, rd = random.uniform(a0, a1), random.uniform(rmin, rmax)
        x, y = rd * math.cos(a), rd * math.sin(a)
        if all(math.hypot(x - ex_, y - ey_) > er + clear for ex_, ey_, er in EX):
            return x, y
    return None


def dress(cfg, leafs, trees=5, bushes=30, a0=0.15, a1=2.95, turf=170000, lips=90):
    """Trees only along the back rim, bushes and stones where nothing works, moss over the lip, then grass."""
    R = cfg["R"]
    for _ in range(trees):
        q = spot_free(R, R * 0.66, R * 0.9, 0.2, a0=a0, a1=a1)
        if q:
            tree(q[0], q[1], h=random.uniform(0.7, 1.25), mat=random.choice(leafs), kind=0)
            EX.append((q[0], q[1], 0.14))
    for _ in range(bushes):
        q = spot_free(R, R * 0.45, R * 0.95, 0.04)
        if q and (not TURF_MASK or not TURF_MASK(np.array([q[0]]), np.array([q[1]]))[0]):
            bush(q[0], q[1], r=random.uniform(0.05, 0.13), mat=random.choice(leafs))
    rocks = []
    for _ in range(int(14 * R / 3)):
        a, rd = random.uniform(0, 6.28), random.uniform(R * 0.55, R * 0.98)
        x, y = rd * math.cos(a), rd * math.sin(a)
        if all(math.hypot(x - ex_, y - ey_) > er for ex_, ey_, er in EX) and (not TURF_MASK or not TURF_MASK(np.array([x]), np.array([y]))[0]):
            rocks.append((x, y, gz(x, y), 0.015 + random.random() ** 3 * 0.13))
    boulders(rocks)
    for _ in range(lips):
        a = random.uniform(0, 6.28)
        Ra = rim_radius(a)
        L = random.uniform(0.25, 1.0) ** 2 * 0.8
        x0, y0, z0 = Ra * math.cos(a), Ra * math.sin(a), top_h(Ra * 0.96 * math.cos(a), Ra * 0.96 * math.sin(a)) - 0.14
        last = np.array((x0, y0, z0))
        sd = random.uniform(0, 40)
        for k in range(1, 7):
            t = k / 6
            nxt = np.array((x0 + 0.03 * noise.noise(Vector((sd, t * 3, 0.0))), y0 + 0.03 * noise.noise(Vector((sd, t * 3, 4.0))), z0 - L * t))
            cyl("vine", last, nxt, 0.008 * (1.2 - t), seg=4, cap=False)
            last = nxt
    build_turf(R, turf, cfg["seed"])


def water(cfg, deg, pool_r, length, width=0.2):
    """A spring feeding a brook that runs off the rim as a thin fall."""
    a = math.radians(deg)
    x, y = pool_r * math.cos(a + 0.2), pool_r * math.sin(a + 0.2)
    pool(x, y, 0.28)
    stones = stream((x, y), a, width=0.075)
    waterfall(a, cfg["R"], length, width, cfg["seed"])
    boulders(stones)


# ---------- station one: the field. Glowing crop in rows, a cut swath, baskets stacked at the pad ----------
def station_field(cfg):
    global TURF_MASK
    R = cfg["R"]
    S = cfg["bs"]
    phi = math.radians(63)
    dx, dy = math.cos(phi), math.sin(phi)     # along the rows, away from the camera and a little right
    nx, ny = math.sin(phi), -math.cos(phi)    # across the rows, to the right
    sp, v0 = 0.25, 0.3                        # right of v0 the crop is already cut
    Rf = R * 0.84
    pad = (R * 0.7, -R * 0.33)
    stack = (R * 0.6, R * 0.03)
    water_at = (-1.72, -2.86)

    def in_field(x, y):
        x, y = np.asarray(x), np.asarray(y)
        return (x * x + y * y < Rf * Rf) & ((x - pad[0]) ** 2 + (y - pad[1]) ** 2 > 0.92 ** 2) & ((x - stack[0]) ** 2 + (y - stack[1]) ** 2 > 0.98 ** 2) & ((x - water_at[0]) ** 2 + (y - water_at[1]) ** 2 > 0.6 ** 2)

    TURF_MASK = in_field
    # tilled soil with a furrow between the rows
    vs = np.arange(-Rf - 0.2, Rf + 0.2, sp / 6)
    us = np.arange(-Rf - 0.2, Rf + 0.2, 0.2)
    V, keep = [], []
    for v in vs:
        for u in us:
            x, y = u * dx + v * nx, u * dy + v * ny
            V.append((x, y, gz(x, y) + 0.016 + 0.014 * math.cos(2 * math.pi * v / sp)))
            keep.append(bool(in_field(x, y)))
    nu, F = len(us), []
    for j in range(len(vs) - 1):
        for i in range(nu - 1):
            a, b, c, d = j * nu + i, j * nu + i + 1, (j + 1) * nu + i + 1, (j + 1) * nu + i
            if keep[a] and keep[b] and keep[c] and keep[d]:
                F.append((a, b, c, d))
    G.add("soil", np.array(V), F, [True] * len(F))
    # the bot walks the lane towards the camera, the row it is cutting on its right hand
    v_b = v0 + 0.72
    u_b = (-1.75 - v_b * ny) / dy
    bx, by = u_b * dx + v_b * nx, u_b * dy + v_b * ny
    # the crop
    for iv in range(int(-Rf / sp) - 1, int(Rf / sp) + 2):
        v = iv * sp
        u = -Rf
        while u < Rf:
            u += 0.082
            j_v, j_u = random.uniform(-0.018, 0.018), random.uniform(-0.02, 0.02)
            x, y = (u + j_u) * dx + (v + j_v) * nx, (u + j_u) * dy + (v + j_v) * ny
            if not in_field(x, y):
                continue
            z = gz(x, y)
            uncut = v < v0 or (v < v0 + sp and u < u_b - 0.1)
            if uncut:
                h = random.uniform(0.56, 0.76) * (1 - 0.3 * max((math.hypot(x, y) - Rf * 0.86) / (Rf * 0.14), 0.0))
                a = random.uniform(0, 6.28)
                lean = random.uniform(0.0, 0.07)
                top = (x + lean * math.cos(a), y + lean * math.sin(a), z + h)
                cyl("stem", (x, y, z), top, 0.013, seg=4, cap=False, r2=0.007)
                sphere("head" if random.random() < 0.72 else "head2", top, 0.05, seg=7, rings=5, sc=(0.82, 0.82, 2.15), rz=random.uniform(0, 3))
            elif random.random() < 0.82:
                cyl("stubble", (x, y, z), (x + random.uniform(-0.012, 0.012), y + random.uniform(-0.012, 0.012), z + random.uniform(0.07, 0.14)), 0.013, seg=4, cap=False, r2=0.007)
                if random.random() < 0.07:
                    sphere("grain", (x + random.uniform(-0.06, 0.06), y + random.uniform(-0.06, 0.06), z + 0.03), 0.018, seg=6, rings=4)
    # the bot, its blade cutting the row, and a cart on a tow bar behind it
    bz = gz(bx, by)
    face = math.atan2(-dx, dy) * 0.0 - math.radians(24)
    bot((bx, by, bz + 0.47 * S + 0.05), S, cfg["shape"], facing=face)
    point((bx - 0.35, by - 0.95, bz + S * 1.2), 20.0, col=(1.0, 0.95, 0.88), r=0.05)
    sx, sy = bx - nx * 0.74 - dx * 0.2, by - ny * 0.74 - dy * 0.2
    head = (bx, by, bz + 0.05 + S * 0.97)
    with PT.drop():
        basket(head, 0.62)
    PT.spot("harvest_head", to_world(cfg, head), scale=0.62 * cfg["scale"])
    cart_u = u_b + 1.42
    cx, cy = cart_u * dx + v_b * nx, cart_u * dy + v_b * ny
    cz = gz(cx, cy) + 0.2
    rz_c = math.atan2(dy, dx)
    box("wood", (cx, cy, cz), (0.96, 0.62, 0.1), r=0.012, rz=rz_c)
    for sgn in (-1, 1):
        for along in (-0.32, 0.32):
            wx, wy = cx + dx * along + nx * sgn * 0.35, cy + dy * along + ny * sgn * 0.35
            cyl("wood", (wx - nx * 0.03, wy - ny * 0.03, cz - 0.07), (wx + nx * 0.03, wy + ny * 0.03, cz - 0.07), 0.13, seg=14)
    beam("brass", (bx + dx * 0.42, by + dy * 0.42, bz + 0.42), (cx - dx * 0.48, cy - dy * 0.48, cz + 0.02), 0.035, 0.035)
    basket((cx - dx * 0.2 - nx * 0.13, cy - dy * 0.2 - ny * 0.13, cz + 0.05), 0.5)
    basket((cx - dx * 0.2 + nx * 0.16, cy - dy * 0.2 + ny * 0.16, cz + 0.05), 0.46)
    basket((cx + dx * 0.25, cy + dy * 0.25, cz + 0.05), 0.5, full=True)
    # grain flying from the blade into the cart
    p0 = np.array((sx, sy, bz + 0.72))
    p2 = np.array((head[0], head[1], head[2] + 0.5))
    p1 = (p0 + p2) / 2 + np.array((0.0, 0.0, 0.62))
    PT.path("grain", [to_world(cfg, (1 - t) ** 2 * p0 + 2 * t * (1 - t) * p1 + t * t * p2) for t in np.linspace(0, 1, 16)])
    with PT.drop():
        for i in range(26):
            t = (i + random.random()) / 26
            q = (1 - t) ** 2 * p0 + 2 * t * (1 - t) * p1 + t * t * p2 + np.array((random.uniform(-0.04, 0.04), random.uniform(-0.04, 0.04), random.uniform(-0.03, 0.03)))
            sphere("grain2", q, random.uniform(0.018, 0.034), seg=7, rings=4, sc=(0.8, 0.8, 1.5), rx=random.uniform(-1, 1))
    # full baskets left along the lane, on their way to the stack
    for k, off in enumerate((2.5, 3.15, 3.8)):
        qu = u_b + off
        qx, qy = qu * dx + v_b * nx, qu * dy + v_b * ny
        if qx * qx + qy * qy < (R * 0.86) ** 2:
            basket((qx, qy, gz(qx, qy)), 0.46)
    for qx, qy in ((1.62, -2.02), (2.2, -2.42), (1.08, -2.72)):
        basket((qx, qy, gz(qx, qy)), 0.5)
    # the stack waiting at the pad: it grows as the field is cut
    pz = landing_pad(pad[0], pad[1], 0.62)
    cfg["out"] = (pad[0], pad[1], pz)
    sz_ = gz(stack[0], stack[1])
    EX.append((stack[0], stack[1], 0.95))
    box("wood", (stack[0], stack[1], sz_ + 0.05), (1.62, 1.12, 0.1), r=0.01)
    s_b = 0.48
    for row, (n, zz) in enumerate(((3, 0), (2, 1), (1, 2))):
        for depth, yy in ((1, 0.27), (0, -0.27)):
            for i in range(n):
                if depth == 0 and zz == 2:
                    continue
                _p = (stack[0] + (i - (n - 1) / 2) * s_b * 1.04, stack[1] + yy, sz_ + 0.1 + zz * s_b * 0.84)
                _rz = random.uniform(0, 3)
                with PT.drop():
                    basket(_p, s_b, rz=_rz)
                PT.spot("stack", to_world(cfg, _p), scale=s_b * cfg["scale"], yaw=_rz + cfg["rz"])
    point((stack[0], stack[1] - 0.9, sz_ + 1.1), 7.0, col=(1.0, 0.6, 0.22), r=0.2)
    with PT.drop():
        basket((pad[0] + 0.05, pad[1] - 0.05, pz), 0.48)
    PT.spot("pad_out_harvest", to_world(cfg, (pad[0] + 0.05, pad[1] - 0.05, pz)), scale=0.48 * cfg["scale"])
    # one low glow over the standing crop, so it lights the bot and the rim
    point((-1.2, 0.4, 1.2), 26, col=(1.0, 0.55, 0.14), r=1.0)
    point((-0.2, -1.8, 1.0), 9, col=(1.0, 0.55, 0.14), r=0.6)
    water(cfg, -122.0, 3.05, 5.2)
    grav_ring(R, cfg["D"], -cfg["D"] * 0.84, False, cfg["scale"])
    dress(cfg, ("leaf_green", "leaf_olive"), trees=4, bushes=26, a0=0.7, a1=2.5, turf=200000)


# ---------- station two: the press. The mill turns the gears, the screw comes down on the pulp, gold runs out ----------
def station_press(cfg):
    R = cfg["R"]
    S = cfg["bs"]
    # the mill behind it, its sails over the left rim
    mx, my = -1.42, 0.98
    EX.append((mx, my, 0.85))
    lathe("stone", (mx, my, 0), [(0.86, -0.2), (0.86, 0.1), (0.76, 0.16), (0.001, 0.16)], seg=40)
    lathe("ceramic", (mx, my, 0.14), [(0.7, 0.0), (0.66, 0.3), (0.5, 2.4), (0.44, 3.1)], seg=40)
    for z_, r_ in ((0.5, 0.65), (1.5, 0.57), (2.5, 0.495)):
        collar(mx, my, z_, r_, t=0.018, w=0.018, seg=40, mat="brass")
    for z_ in (1.0, 2.0):
        a_ = -math.pi / 2 - 0.3
        r_ = 0.6 if z_ < 1.2 else 0.53
        box("window", (mx + r_ * math.cos(a_), my + r_ * math.sin(a_), z_), (0.012, 0.18, 0.32), r=0.0, rz=a_)
    lathe("wood", (mx, my, 3.2), [(0.56, 0.0), (0.52, 0.12), (0.34, 0.42), (0.001, 0.55)], seg=28)
    hub = (mx, my - 0.62, 3.44)
    cyl("dark", (mx, my, 3.44), hub, 0.07, seg=12)
    with PT.actor("sails", pivot=to_world(cfg, hub)):
        sphere("gold", hub, 0.17, seg=16, rings=10, sc=(1, 1.1, 1))
        for k in range(4):
            sail(hub, 0.42 + k * math.pi / 2, 2.1, 0.5)
    PT.spot("sails_axis", to_world(cfg, hub + np.array((0.0, 1.0, 0.0))))
    # the press
    px, py = 0.0, 0.05
    EX.append((px, py, 1.25))
    lathe("stone", (px, py, 0), [(1.22, -0.2), (1.22, 0.06), (1.16, 0.1), (0.001, 0.1)], seg=56)
    box("wood", (px - 1.0, py, 1.3), (0.22, 0.26, 2.5), r=0.02)
    box("wood", (px + 1.0, py, 1.3), (0.22, 0.26, 2.5), r=0.02)
    box("wood", (px, py, 2.54), (2.38, 0.32, 0.3), r=0.025)
    for sgn in (-1, 1):
        for z_ in (0.5, 1.5):
            box("brass", (px + sgn * 1.0, py - 0.135, z_), (0.25, 0.012, 0.07), r=0.003)
        beam("wood", (px + sgn * 1.0, py, 0.72), (px + sgn * 1.36, py, 0.1), 0.13, 0.15)
    # vat, pulp, platen, screw
    lathe("wood", (px, py, 0.1), [(0.001, 0.0), (0.82, 0.0), (0.84, 0.03), (0.87, 0.66), (0.81, 0.67), (0.76, 0.1)], seg=48)
    for z_ in (0.24, 0.52):
        torus("brass", (px, py, 0.1 + z_), 0.86, 0.022, seg=48, tseg=6)
    lathe("juice", (px, py, 0.7), [(0.8, -0.02), (0.73, 0.04), (0.001, 0.05)], seg=40)
    for _ in range(46):
        a, rd = random.uniform(0, 6.28), random.uniform(0.62, 0.84)
        sphere("grain2", (px + rd * math.cos(a), py + rd * math.sin(a), 0.74 + random.uniform(-0.02, 0.05)), 0.042, seg=6, rings=4, sc=(0.85, 0.85, 1.3), rz=random.uniform(0, 3))
    with PT.actor("screw", pivot=to_world(cfg, (px, py, 1.7))):
        lathe("brass", (px, py, 0.78), [(0.68, 0.0), (0.68, 0.1), (0.2, 0.17), (0.1, 0.26), (0.001, 0.26)], seg=44)
        cyl("gold", (px, py, 0.96), (px, py, 2.42), 0.085, seg=14)
        pts = [(px + 0.125 * math.cos(t * 2.2), py + 0.125 * math.sin(t * 2.2), 1.0 + t * 0.048) for t in np.linspace(0, 29, 150)]
        for p, q in zip(pts, pts[1:]):
            cyl("gold", p, q, 0.034, seg=6, cap=False)
    # the drive: mill hub, rod, small gear, big gear on the screw
    g1 = (px, py - 0.24, 3.02)
    g2 = (px - 0.71, py - 0.24, 3.27)
    with PT.actor("gear_big", pivot=to_world(cfg, g1)):
        gear(g1, 0.46, 18, w=0.09)
    with PT.actor("gear_small", pivot=to_world(cfg, g2)):
        gear(g2, 0.3, 12, w=0.09, mat="brass", rot=0.1)
    PT.spot("gear_axis", to_world(cfg, (g1[0], g1[1] + 1.0, g1[2])))
    box("wood", (px, py - 0.04, 2.84), (0.14, 0.2, 0.36), r=0.015)
    cyl("dark", (g1[0], g1[1] + 0.04, g1[2]), (g1[0], py, 2.68), 0.05, seg=10)
    beam("wood", (g2[0], py - 0.04, 2.66), (g2[0], py - 0.04, g2[2]), 0.1, 0.12)
    cyl("gold", (hub[0], hub[1], hub[2] - 0.02), (g2[0], g2[1], g2[2]), 0.034, seg=10)
    # gold runs from the spout into a jar on the bench; the filled ones wait beside it
    sp_ = (px - 0.1, py - 0.87, 0.46)
    sp2 = (px - 0.14, py - 1.13, 0.42)
    cyl("brass", sp_, sp2, 0.055, seg=10, r2=0.045)
    bz = 0.22
    box("wood", (px - 0.72, py - 1.14, bz - 0.04), (1.72, 0.38, 0.07), r=0.012)
    for x_ in (px - 1.45, px + 0.02):
        beam("wood", (x_, py - 1.14, bz - 0.06), (x_, py - 1.14, -0.05), 0.08, 0.26)
    cyl("juice", (sp2[0], sp2[1], sp2[2] - 0.01), (sp2[0], sp2[1], bz + 0.22), 0.02, seg=8, r2=0.024)
    for i in range(5):
        with PT.drop():
            jar((px - 0.14 - i * 0.31, py - 1.14, bz), 0.32)
        PT.spot("bench", to_world(cfg, (px - 0.14 - i * 0.31, py - 1.14, bz)), scale=0.32 * cfg["scale"])
    point((sp2[0] - 0.1, sp2[1] - 0.25, 0.75), 3.0, col=(1.0, 0.56, 0.16), r=0.1)
    EX.append((px - 0.72, py - 1.14, 0.9))
    # the bot throws its weight on the clutch lever
    bx, by = 1.38, -1.12
    lz = 0.22
    lever_hi = (px + 0.72, py - 0.62, 0.92)
    lever_lo = (bx + 0.34, by - 0.02, lz + 0.03)
    box("wood", (1.0, -0.86, 0.26), (0.2, 0.3, 0.52), r=0.02)
    cyl("brass", (1.0, -1.02, 0.52), (1.0, -0.72, 0.52), 0.05, seg=10)
    with PT.actor("lever", pivot=to_world(cfg, (1.0, -0.86, 0.52))):
        beam("gold", lever_hi, lever_lo, 0.13, 0.08)
    PT.spot("lever_axis", to_world(cfg, (1.0, -0.72, 0.52)))
    box("wood", (bx, by, lz + 0.03), (0.62, 0.42, 0.07), r=0.012)
    bot((bx, by, lz + 0.42 + 0.47 * S), S, cfg["shape"], facing=math.radians(-22), pitch=math.radians(3))
    point((bx - 0.2, by - 1.0, 1.35), 6.0, col=(1.0, 0.86, 0.66), r=0.05)
    EX.append((bx, by, 0.75))
    # baskets come up a belt from the landing pad and tip into the vat
    pad_i = (-2.32, -0.72)
    pz = landing_pad(pad_i[0], pad_i[1], 0.5)
    cfg["in"] = (pad_i[0], pad_i[1], pz)
    a_ = np.array((-1.98, -0.28, 0.34))
    b_ = np.array((-0.72, 0.0, 0.98))
    beam("rubber", a_, b_, 0.42, 0.05)
    beam("brass", a_ + (0, 0, 0.04) + np.array((0.03, 0.22, 0.0)), b_ + (0, 0, 0.04) + np.array((0.03, 0.22, 0.0)), 0.02, 0.05)
    beam("brass", a_ + (0, 0, 0.04) - np.array((0.03, 0.22, 0.0)), b_ + (0, 0, 0.04) - np.array((0.03, 0.22, 0.0)), 0.02, 0.05)
    for t in (0.0, 0.5, 0.97):
        q = a_ + (b_ - a_) * t
        cyl("wood", (q[0], q[1], q[2] - 0.03), (q[0], q[1], 0.0), 0.035, seg=7)
    PT.path("belt", [to_world(cfg, a_ + (0, 0, 0.02)), to_world(cfg, b_ + (0, 0, 0.02))])
    PT.spot("belt_scale", to_world(cfg, a_), scale=0.42 * cfg["scale"])
    for t in (0.22, 0.62):
        q = a_ + (b_ - a_) * t
        with PT.drop():
            basket((q[0], q[1], q[2] + 0.02), 0.42)
    EX.append((-1.35, -0.14, 0.7))
    # waiting at the pad
    basket((pad_i[0] - 0.46, pad_i[1] + 0.58, gz(pad_i[0] - 0.46, pad_i[1] + 0.58)), 0.42)
    basket((pad_i[0] + 0.02, pad_i[1] + 0.7, gz(pad_i[0] + 0.02, pad_i[1] + 0.7)), 0.42)
    basket((pad_i[0] - 0.22, pad_i[1] + 0.64, gz(pad_i[0] - 0.22, pad_i[1] + 0.64) + 0.34), 0.42)
    # the rack: this is what piles up
    rx, ry = 2.02, 0.72
    w_, n_col = 1.5, 5
    EX.append((rx, ry, 1.0))
    for x_ in (rx - w_ / 2, rx + w_ / 2):
        for y_ in (ry - 0.17, ry + 0.17):
            box("wood", (x_, y_, 1.0), (0.07, 0.07, 2.08), r=0.008)
    rows = (5, 5, 5, 2)
    for j, cnt in enumerate(rows):
        z_ = 0.2 + j * 0.5
        box("wood", (rx, ry, z_), (w_ + 0.1, 0.4, 0.045), r=0.008)
        for i in range(cnt):
            with PT.drop():
                jar((rx - w_ / 2 + 0.17 + i * (w_ - 0.34) / (n_col - 1), ry - 0.02, z_ + 0.024), 0.33)
        for i in range(n_col):
            PT.spot("rack", to_world(cfg, (rx - w_ / 2 + 0.17 + i * (w_ - 0.34) / (n_col - 1), ry - 0.02, z_ + 0.024)), scale=0.33 * cfg["scale"])
    point((rx, ry - 0.7, 1.3), 4.0, col=(1.0, 0.56, 0.16), r=0.2)
    # the way out: jars at the pad on the side towards the next hop
    pad_o = (2.42, -0.5)
    pz = landing_pad(pad_o[0], pad_o[1], 0.46)
    cfg["out"] = (pad_o[0], pad_o[1], pz)
    with PT.drop():
        jar((pad_o[0] + 0.08, pad_o[1] - 0.02, pz), 0.34)
    PT.spot("pad_out_press", to_world(cfg, (pad_o[0] + 0.08, pad_o[1] - 0.02, pz)), scale=0.34 * cfg["scale"])
    water(cfg, -70.0, 2.1, 5.8, width=0.18)
    grav_ring(R, cfg["D"], -cfg["D"] * 0.86, False, cfg["scale"])
    dress(cfg, ("leaf_green", "leaf_olive"), trees=4, bushes=26, a0=0.9, a1=2.4, turf=130000)


# ---------- station three: the beacon. Jars pour into a glass column, the level rises, the lamp burns under the spire ----------
def station_beacon(cfg):
    R = cfg["R"]
    S = cfg["bs"]
    x, y = 0.42, 0.62
    EX.append((x, y, 1.6))
    lathe("stone", (x, y, 0), [(1.56, -0.25), (1.56, 0.12), (1.47, 0.16), (1.28, 0.16), (1.28, 0.22), (1.2, 0.24)], seg=96)
    collar(x, y, 0.15, 1.48, t=0.012, w=0.014, seg=96)
    lathe("ceramic", (x, y, 0.22), [(1.14, 0.0), (1.14, 0.06), (1.03, 0.09), (1.03, 0.66), (1.17, 0.72), (1.17, 0.8), (0.8, 0.87), (0.72, 0.87)], seg=96)
    pixel_wall(x, y, 0.34, 0.86, 1.03, 3, 30)
    for i in range(24):
        a = math.pi - 0.75 + i * (math.pi + 1.5) / 23
        cyl("gold", (x + 1.1 * math.cos(a), y + 1.1 * math.sin(a), 0.28), (x + 1.1 * math.cos(a), y + 1.1 * math.sin(a), 0.95), 0.019, seg=8)
    collar(x, y, 1.0, 1.17, t=0.014, w=0.014, seg=96)
    # the column: its level shows how much of the harvest has gone up
    z0, z1 = 1.08, 2.42
    level = z0 + (z1 - z0) * 0.74
    with PT.actor("column", pivot=to_world(cfg, (x, y, z0))):
        lathe("juice_deep", (x, y, 0), [(0.001, z0), (0.6, z0), (0.6, level), (0.56, level + 0.015), (0.001, level + 0.02)], seg=48)
    lathe("glass_thin", (x, y, 0), [(0.67, z0 - 0.02), (0.67, z1 + 0.02)], seg=48)
    for t in np.linspace(0, 1, 6):
        collar(x, y, z0 + (z1 - z0) * float(t), 0.67, t=0.012, w=0.012, seg=48, mat="gold" if t in (0.0, 1.0) else "brass")
    for i in range(8):
        a = -math.pi / 2 + (i - 3.5) * 0.76
        cyl("gold", (x + 0.69 * math.cos(a), y + 0.69 * math.sin(a), z0), (x + 0.69 * math.cos(a), y + 0.69 * math.sin(a), z1), 0.014, seg=6)
    # the lamp, then the golden spire
    lathe("ceramic", (x, y, z1), [(0.78, 0.0), (0.78, 0.07), (0.6, 0.11), (0.44, 0.13)], seg=56)
    collar(x, y, z1 + 0.07, 0.78, t=0.012, w=0.012, seg=56)
    zl = z1 + 0.42
    sphere("beacon", (x, y, zl), 0.31, seg=28, rings=18)
    point((x, y - 0.5, zl), 34, col=(1.0, 0.58, 0.18), r=0.3)
    for i in range(6):
        a = i * math.pi / 3 + 0.25
        pts = []
        for t in np.linspace(-1, 1, 9):
            ang = float(t) * 1.2
            pts.append((x + 0.42 * math.cos(ang) * math.cos(a), y + 0.42 * math.cos(ang) * math.sin(a), zl + 0.42 * math.sin(ang)))
        for p, q in zip(pts, pts[1:]):
            cyl("gold", p, q, 0.012, seg=5, cap=False)
    Z = zl + 0.34
    prof = [(0.34, Z), (0.28, Z + 0.1), (0.2, Z + 0.34), (0.13, Z + 0.72), (0.08, Z + 1.12), (0.035, Z + 1.5), (0.012, Z + 1.78), (0.002, Z + 2.0)]
    pr = []
    for i in range(len(prof) - 1):
        for t in np.linspace(0, 1, 4, endpoint=False):
            pr.append((prof[i][0] + (prof[i + 1][0] - prof[i][0]) * float(t), prof[i][1] + (prof[i + 1][1] - prof[i][1]) * float(t)))
    pr.append(prof[-1])
    lathe("gold", (x, y, 0), pr, seg=40)
    for f in (0.1, 0.34, 0.72, 1.12):
        r_ = float(np.interp(Z + f, [p[1] for p in prof], [p[0] for p in prof]))
        collar(x, y, Z + f, r_, t=0.014, w=0.016, mat="brass", seg=32)
    for zh, Rh, th in ((Z + 0.42, 0.78, 0.034), (Z + 1.02, 0.5, 0.026)):
        torus("gold", (x, y, zh), Rh, th, seg=80, tseg=10)
        torus("field", (x, y, zh - th * 0.6), Rh - th * 1.15, th * 0.42, seg=80, tseg=6)
        point((x, y, zh - 0.02), 1.4 * Rh, col=CYAN, r=Rh * 0.6)
    sphere("lamp", (x, y, Z + 2.02), 0.035, seg=10, rings=6)
    # the feed: a funnel and a pipe into the column, the lead on its step, a jar floating over the funnel, pouring
    fx, fy = -0.28, -0.72
    EX.append((fx, fy, 0.3))
    fz = 0.86
    cyl("brass", (fx, fy, 0.0), (fx, fy, fz), 0.05, seg=10)
    lathe("gold", (fx, fy, fz), [(0.05, 0.0), (0.08, 0.1), (0.34, 0.36), (0.36, 0.4), (0.31, 0.4), (0.06, 0.12)], seg=28)
    pp = [(fx, fy, fz + 0.06), (fx + 0.32, fy + 0.3, fz + 0.3), (x - 0.42, y - 0.5, 1.5)]
    for p, q in zip(pp, pp[1:]):
        cyl("brass", p, q, 0.036, seg=10)
    lathe("juice", (fx, fy, fz + 0.26), [(0.27, 0.0), (0.001, 0.015)], seg=20)
    lx, ly = -1.22, -0.82
    step = 0.4
    z_ = gz(lx, ly)
    EX.append((lx, ly, 0.86))
    lathe("paver", (lx, ly, z_), [(0.78, -0.12), (0.78, 0.13), (0.74, 0.17), (0.6, 0.17), (0.58, 0.32), (0.54, step), (0.001, step)], seg=48)
    lathe("ceramic", (lx, ly, z_ + step), [(0.5, 0.0), (0.48, 0.022), (0.001, 0.024)], seg=48)
    collar(lx, ly, z_ + 0.14, 0.76, t=0.012, w=0.012, seg=48)
    bot((lx, ly, z_ + step + 0.05 + 0.47 * S), S, cfg["shape"], facing=math.radians(12), pitch=math.radians(14))
    point((lx - 0.3, ly - 1.1, z_ + step + S * 1.25), 8.0, col=(1.0, 0.86, 0.66), r=0.05)
    jx, jy, jz = fx - 0.14, fy - 0.02, fz + 0.98
    tilt_ = np.array((0.74, 0.0, -0.67))
    j_a = np.array((jx - tilt_[0] * 0.22, jy, jz - tilt_[2] * 0.22))
    j_b = j_a + tilt_ * 0.36
    with PT.actor("pour", pivot=to_world(cfg, j_a)):
        cyl("jar_gold", j_a, j_b, 0.2, seg=18)
        sphere("jar_gold", j_a, 0.2, seg=14, rings=8)
        cyl("jar_gold", j_b, j_b + tilt_ * 0.08, 0.2, seg=18, r2=0.1)
        cyl("brass", j_b + tilt_ * 0.08, j_b + tilt_ * 0.14, 0.085, seg=12)
        torus("field", j_a + tilt_ * 0.05 - np.array((0.0, 0.0, 0.26)), 0.17, 0.012, seg=28, tseg=5)
        lip = j_b + tilt_ * 0.14
        cyl("juice", lip, (fx + 0.02, fy, fz + 0.27), 0.03, seg=8, r2=0.04)
    # delivered jars piled by the landing pad
    pad_i = (-2.08, 0.28)
    pz = landing_pad(pad_i[0], pad_i[1], 0.48)
    cfg["in"] = (pad_i[0], pad_i[1], pz)
    PT.spot("beacon_lamp", to_world(cfg, (x, y, zl)), scale=cfg["scale"])
    sx, sy = -1.2, 0.62
    EX.append((sx, sy, 0.6))
    z_s = gz(sx, sy)
    box("wood", (sx, sy, z_s + 0.04), (1.0, 0.72, 0.08), r=0.01)
    for zz, n in enumerate((3, 2, 1)):
        for dd in (0.17, -0.17):
            for i in range(n):
                if zz == 2 and dd < 0:
                    continue
                with PT.drop():
                    jar((sx + (i - (n - 1) / 2) * 0.31, sy + dd, z_s + 0.08 + zz * 0.32), 0.32)
                PT.spot("delivered", to_world(cfg, (sx + (i - (n - 1) / 2) * 0.31, sy + dd, z_s + 0.08 + zz * 0.32)), scale=0.32 * cfg["scale"])
    water(cfg, -48.0, 1.75, 6.4, width=0.17)
    grav_ring(R, cfg["D"], -cfg["D"] * 0.86, False, cfg["scale"])
    dress(cfg, ("leaf_olive", "leaf_green"), trees=0, bushes=22, a0=-0.5, a1=1.3, turf=120000)


# ---------- the small rocks between: one pad, nothing else ----------
def station_relay(cfg):
    global RING_K
    R = cfg["R"]
    pz = landing_pad(0.0, -0.08, R * 0.5)
    cfg["pad"] = (0.0, -0.08, pz)
    RING_K = 0.3
    grav_ring(R, cfg["D"], -cfg["D"] * 0.84, False, cfg["scale"])
    RING_K = 1.0
    if cfg.get("fall"):
        waterfall(math.radians(cfg["fall"]), R, 3.2, 0.1, cfg["seed"])
    dress(cfg, ("leaf_olive", "leaf_green"), trees=cfg.get("trees", 1), bushes=8, a0=1.0, a1=2.2, turf=16000, lips=26)


STATIONS = dict(field=station_field, press=station_press, beacon=station_beacon, relay=station_relay)
for w_ in WORLD_CFG:
    w_["rz"] = math.atan2(CAMXY[0] - w_["x"], -(CAMXY[1] - w_["y"]))
for w_ in WORLD_CFG:
    begin_world(w_)
    STATIONS[w_["station"]](w_)
    end_world(w_)
CUR = {}
TURF_MASK = None
G = Geo()


# ---------- the chain: drones hop from pad to pad, each leg a slim arc, cargo slung underneath ----------
def hop(a, b, lift):
    mid = (a + b) / 2 + np.array((0.0, 0.0, lift))
    return [(1 - t) ** 2 * a + 2 * t * (1 - t) * mid + t * t * b for t in np.linspace(0, 1, 44)]


def carry(p, kind, rz=0.0):
    d = float(p[1])
    s = d * 0.0255
    drone(p, s=s, rz=rz)
    cs = d * (0.026 if kind == "basket" else 0.024)
    top = p - np.array((0.0, 0.0, s * 0.62))
    for sx_ in (-1, 1):
        cyl("rail", p + np.array((sx_ * s * 0.1, 0.0, -s * 0.14)), top + np.array((sx_ * cs * 0.3, 0.0, 0.0)), d * 0.00028, seg=4, cap=False)
    if kind == "basket":
        basket(top - np.array((0.0, 0.0, cs * 0.66)), cs, rz=rz)
    else:
        jar(top - np.array((0.0, 0.0, cs * 0.96)), cs)
    point(top + np.array((0.0, -cs * 1.6, -cs * 0.2)), 0.012 * d, col=(1.0, 0.58, 0.18), r=0.1)


def tube(mat, pts, r, seg=6):
    for p, q in zip(pts, pts[1:]):
        cyl(mat, p, q, r, seg=seg, cap=False)


CUR = dict(led_hot="stud")
_wc = {w_["key"]: w_ for w_ in WORLD_CFG}
_lift = np.array((0.0, 0.0, 0.0))
LEGS = (
    ("basket", to_world(_wc["harvest"], _wc["harvest"]["out"]), to_world(_wc["relay1"], _wc["relay1"]["pad"]), (0.55,)),
    ("basket", to_world(_wc["relay1"], _wc["relay1"]["pad"]), to_world(_wc["press"], _wc["press"]["in"]), (0.5,)),
    ("jar", to_world(_wc["press"], _wc["press"]["out"]), to_world(_wc["relay2"], _wc["relay2"]["pad"]), (0.55,)),
    ("jar", to_world(_wc["relay2"], _wc["relay2"]["pad"]), to_world(_wc["lead"], _wc["lead"]["in"]), (0.5,)),
)
_r = random.Random(9)
for _li, (kind, a_, b_, where) in enumerate(LEGS):
    L_ = float(np.linalg.norm(b_ - a_))
    d_ = float((a_[1] + b_[1]) / 2)
    pts = hop(a_ + np.array((0.0, 0.0, d_ * 0.02)), b_ + np.array((0.0, 0.0, d_ * 0.03)), L_ * 0.34)
    for i in range(0, len(pts) - 2, 3):      # dashes
        cyl("trail", pts[i], pts[i + 2], d_ * 0.001, seg=5, cap=False)
    PT.path(f"leg{_li}", [p + np.array((0.0, 0.0, d_ * 0.016)) for p in pts[::3]])
    with PT.drop():
        for t in where:
            i_ = int(t * (len(pts) - 1))
            p = pts[i_]
            tube("stud", pts[max(i_ - 7, 0): i_ + 1], d_ * 0.0012)
            carry(p + np.array((0.0, 0.0, d_ * 0.016)), kind, rz=_r.uniform(0, 3))
# drones on the ground and just lifting off: the chain never stops
with PT.drop():
    _lp = to_world(_wc["harvest"], _wc["harvest"]["out"])
    carry(_lp + np.array((0.0, 0.0, 1.05)), "basket", rz=0.5)
    _lp = to_world(_wc["relay1"], _wc["relay1"]["pad"])
    carry(_lp + np.array((0.0, 0.0, 0.92)), "basket", rz=1.1)
    _lp = to_world(_wc["press"], _wc["press"]["in"])
    carry(_lp + np.array((0.0, 0.0, 0.98)), "basket", rz=2.0)
    _lp = to_world(_wc["lead"], _wc["lead"]["in"])
    carry(_lp + np.array((0.0, 0.0, 1.35)), "jar", rz=1.7)
# one of each, made at unit size, for the live copies
if PT.ON:
    with PT.actor("basket", pivot=(0, 0, 0)):
        basket((0.0, 0.0, 0.0), 1.0)
    with PT.actor("jar", pivot=(0, 0, 0)):
        jar((0.0, 0.0, 0.0), 1.0)
    with PT.actor("carrier_basket", pivot=(0, 1, 0)):
        carry(np.array((0.0, 1.0, 0.0)), "basket")
    with PT.actor("carrier_jar", pivot=(0, 1, 0)):
        carry(np.array((0.0, 1.0, 0.0)), "jar")
    with PT.actor("grainfly", pivot=(0, 0, 0)):
        sphere("grain2", (0.0, 0.0, 0.0), 1.0, seg=8, rings=5, sc=(0.8, 0.8, 1.5))
    PT.accents(harvest=["led_on_harvest", "led_dim_harvest", "led_hot_harvest"], press=["led_on_press", "led_dim_press", "led_hot_press"], lead=["led_on_lead", "led_dim_lead", "led_hot_lead"])
    PT.masks(water=["fall", "fall_b", "fall_c", "fall_d", "water"], flow=["cloud"], pulse=["lamp", "beacon", "juice", "field", "trail", "grain", "grain2", "head", "head2"])
    # Heads carry the full bend (the live gust light keys on that), everything else stays well under it.
    PT.motion(
        head=dict(bend=1.0, phase_scale=1.5),
        head2=dict(bend=1.0, phase_scale=1.5),
        stem=dict(axis="object", h=0.95, bend=0.82, phase_scale=1.5),
        stubble=dict(bend=0.1, phase_scale=4.0),
        leaf_green=dict(axis="object", h=1.6, bend=0.85, phase_scale=5.0),
        leaf_olive=dict(axis="object", h=1.5, bend=0.85, phase_scale=5.0),
        leaf_gold=dict(axis="object", h=1.6, bend=0.6, phase_scale=2.2),
        leaf_rust=dict(axis="object", h=1.6, bend=0.6, phase_scale=2.2),
        bark=dict(axis="object", h=1.0, bend=0.28, phase_scale=2.2),
        grass=dict(bend=0.26, phase_scale=7.0),
        flower_gold=dict(bend=0.34, phase_scale=7.0),
        flower_pink=dict(bend=0.34, phase_scale=7.0),
        mist=dict(bend=0.55, phase_scale=0.5),
        fall=dict(run=1.0),
        fall_b=dict(run=0.1),
    )
    # Three channels, five isles: each little relay isle shares a sphere, and so a beat, with its big neighbour.
    PT.lift([(-5.5, 16.4, -1.2, 5.3), (2.6, 23.6, 3.2, 6.9), (11.7, 33.0, 7.2, 6.2)], skip=["cloud", "mist"])
    PT.flat("wicker", (0.42, 0.24, 0.1), rough=0.75)
    PT.flat("wicker2", (0.3, 0.16, 0.06), rough=0.8)
    PT.flat("grain", (0.9, 0.55, 0.1), rough=0.5, emis=(1.0, 0.5, 0.06), emis_str=0.55)
    PT.flat("grain2", (0.95, 0.62, 0.14), rough=0.5, emis=(1.0, 0.56, 0.1), emis_str=0.75)
    PT.flat("rotor", (0.12, 0.12, 0.13), rough=0.4, alpha=0.32)
    PT.flat("brass", (0.62, 0.42, 0.17), rough=0.34, metal=1.0)
    PT.flat("gold", (0.82, 0.47, 0.1), rough=0.3, metal=1.0)
    PT.flat("ceramic", (0.7, 0.64, 0.55), rough=0.36)
    PT.flat("jar_gold", (0.7, 0.32, 0.006), rough=0.14, emis=(1.0, 0.4, 0.006), emis_str=0.3)
CUR = {}


# ---------- the sea of clouds ----------
def build_cloud_floor():
    h_ = CP.z - FLOOR_Z
    bot_ang = PITCH + math.atan((36 * 9 / 16 / 2) / LENS)
    near = h_ / math.tan(bot_ang) * 0.33
    far = CLOUD_EDGE * 1.02
    half = lambda w: math.hypot(w, h_) * 18.0 / LENS * 1.45
    xmax = half(far) + 6
    ox, oy = CP.x - xmax, CP.y + near - 8
    res = 0.1
    size_x, size_y = xmax * 2, far - near + 16
    # far away only the big shapes matter, so use a coarser field beyond the worlds
    res = max(0.1, math.sqrt(size_x * size_y / 22e6))
    nx, ny = int(size_x / res) + 2, int(size_y / res) + 2
    print("cloud field", nx, ny, "res", round(res, 3), flush=True)
    H = np.full((ny, nx), FLOOR_Z - 3.0, dtype=np.float32)
    rng = np.random.default_rng(3)

    def dune(cx, cy, cz, r):
        i0, i1 = max(int((cx - r - ox) / res), 0), min(int((cx + r - ox) / res) + 2, nx)
        j0, j1 = max(int((cy - r - oy) / res), 0), min(int((cy + r - oy) / res) + 2, ny)
        if i0 >= i1 or j0 >= j1:
            return
        xs = ox + res * np.arange(i0, i1) - cx
        ys = oy + res * np.arange(j0, j1) - cy
        d = r * r - (xs * xs + (ys * ys)[:, None])
        top = np.where(d > 0, cz + np.sqrt(np.maximum(d, 0)), -1e3).astype(np.float32)
        sub = H[j0:j1, i0:i1]
        np.maximum(sub, top, out=sub)

    def puff(F, cx, cy, r, sink, squash):
        """A bump added to the frozen terrain F, so it follows the ground under its whole footprint."""
        i0, i1 = max(int((cx - r - ox) / res), 0), min(int((cx + r - ox) / res) + 2, nx)
        j0, j1 = max(int((cy - r - oy) / res), 0), min(int((cy + r - oy) / res) + 2, ny)
        if i0 >= i1 or j0 >= j1:
            return
        xs = ox + res * np.arange(i0, i1) - cx
        ys = oy + res * np.arange(j0, j1) - cy
        d = r * r - (xs * xs + (ys * ys)[:, None])
        top = F[j0:j1, i0:i1] + np.where(d > 0, squash * (np.sqrt(np.maximum(d, 0)) - sink * r), -1e3).astype(np.float32)
        sub = H[j0:j1, i0:i1]
        np.maximum(sub, top, out=sub)

    area = size_x * size_y
    # dunes
    for _ in range(int(area / 330)):
        x, y = rng.uniform(ox, ox + size_x), rng.uniform(oy, oy + size_y)
        r = rng.uniform(9, 24)
        k = 0.5 + 0.5 * noise.noise(Vector((x * 0.02, y * 0.02, 3.0)))
        dune(x, y, FLOOR_Z - r * rng.uniform(0.86, 1.02) + 3.5 * k, r)
    # heads, then lumps of cotton on the heads
    for count, r0, r1, sink, sq in ((area / 14, 2.4, 6.5, 0.5, 0.95), (area / 2.0, 0.8, 2.1, 0.45, 0.95)):
        F = H.copy()
        for _ in range(int(count)):
            x, y = rng.uniform(ox, ox + size_x), rng.uniform(oy, oy + size_y)
            r = rng.uniform(r0, r1)
            if r0 < 1 and math.hypot(x - CP.x, y - CP.y) > CAMD * 2.0 and rng.random() < 0.6:
                continue
            puff(F, x, y, r, sink, sq)
    # tiny lumps only near the worlds
    F = H.copy()
    w0 = max(near, CAMD * 0.45)
    for _ in range(int(min(110000, area / 1.0))):
        d_ = rng.uniform(w0, CAMD * 1.7)
        x = CP.x + rng.uniform(-1, 1) * half(d_) * 1.05
        y = CP.y + d_
        puff(F, x, y, rng.uniform(0.24, 0.65), 0.42, 0.95)
    del F
    print("cloud stamped", flush=True)
    NU, NW = (1560, 540)
    ws = np.geomspace(near, far, NW)
    us = np.linspace(-1, 1, NU)
    X = CP.x + np.outer(np.hypot(ws, h_) * 18.0 / LENS * 1.45, us)
    Y = np.repeat((CP.y + ws)[:, None], NU, axis=1)
    fx = np.clip((X - ox) / res, 0, nx - 1.001)
    fy = np.clip((Y - oy) / res, 0, ny - 1.001)
    ix, iy = fx.astype(int), fy.astype(int)
    wx, wy = fx - ix, fy - iy
    Z = H[iy, ix] * (1 - wx) * (1 - wy) + H[iy, ix + 1] * wx * (1 - wy) + H[iy + 1, ix] * (1 - wx) * wy + H[iy + 1, ix + 1] * wx * wy
    del H
    V = np.stack((X, Y, Z), axis=-1).reshape(-1, 3)
    me = bpy.data.meshes.new("cloud_floor")
    me.vertices.add(len(V))
    me.vertices.foreach_set("co", V.astype(np.float32).ravel())
    j = np.arange(NW - 1)[:, None]
    i = np.arange(NU - 1)[None, :]
    a = (j * NU + i).ravel()
    idx = np.stack((a, a + 1, a + NU + 1, a + NU), axis=1).ravel()
    me.loops.add(len(idx))
    me.loops.foreach_set("vertex_index", idx.astype(np.int32))
    me.polygons.add(len(a))
    me.polygons.foreach_set("loop_start", (np.arange(len(a)) * 4).astype(np.int32))
    me.update(calc_edges=True)
    me.polygons.foreach_set("use_smooth", [True] * len(a))
    me.materials.append(MATS["cloud"])
    bpy.context.collection.objects.link(bpy.data.objects.new("cloud_floor", me))
    print("cloud floor verts", len(V), flush=True)


build_cloud_floor()


def heap_mesh(seed, n_big=5):
    """A cumulus you could pull apart: spheres on spheres on spheres, welded by the voxel remesher."""
    rnd = random.Random(seed)
    S = []
    for _ in range(n_big):
        S.append((rnd.gauss(0, 0.8), rnd.gauss(0, 0.55), rnd.uniform(0.05, 0.42), rnd.uniform(0.5, 0.95)))
    S.append((0.0, 0.0, 0.5, 1.0))

    def grow(par, count, r0, r1):
        out = []
        for _ in range(count):
            cx, cy, cz, r = rnd.choice(par)
            th, ph = rnd.uniform(0, 6.28), rnd.uniform(-0.25, 1.35)
            c = (cx + r * math.cos(ph) * math.cos(th), cy + r * math.cos(ph) * math.sin(th), cz + r * math.sin(ph))
            out.append((c[0], c[1], c[2], rnd.uniform(r0, r1)))
        return out

    M_ = grow(S, 46, 0.2, 0.42)
    L_ = grow(M_, 240, 0.09, 0.19) + grow(S, 60, 0.12, 0.22)
    L_ = L_ + grow(L_, 420, 0.05, 0.095)
    bm = bmesh.new()
    for cx, cy, cz, r in S + M_ + L_:
        bmesh.ops.create_icosphere(bm, subdivisions=3 if r > 0.12 else 2, radius=r, matrix=Matrix.Translation((cx, cy, cz)))
    me = bpy.data.meshes.new("heap_src")
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new("heap_src", me)
    bpy.context.collection.objects.link(o)
    md = o.modifiers.new("r", "REMESH")
    md.mode = "VOXEL"
    md.voxel_size = 0.019
    md.use_smooth_shade = True
    dg = bpy.context.evaluated_depsgraph_get()
    me2 = bpy.data.meshes.new_from_object(o.evaluated_get(dg))
    bpy.data.objects.remove(o)
    bpy.data.meshes.remove(me)
    me2.polygons.foreach_set("use_smooth", [True] * len(me2.polygons))
    me2.materials.clear()
    me2.materials.append(MATS["cloud"])
    print("heap", seed, len(me2.polygons), flush=True)
    return me2


HEAPS = [heap_mesh(s) for s in (1, 2, 3, 4)]
_hr = random.Random(21)


def put_heap(x, y, z, s, sz=0.8):
    o = bpy.data.objects.new("heap", _hr.choice(HEAPS))
    o.location = (x, y, z)
    o.scale = (s, s * _hr.uniform(0.8, 1.15), s * sz)
    o.rotation_euler = (0, 0, _hr.uniform(0, 6.28))
    bpy.context.collection.objects.link(o)


# heaps breaking through the sea: low near the line, taller far off, the sun side stays open
for _ in range(440):
    d_ = 28.0 * (9.0 ** _hr.random())
    x = CP.x + _hr.uniform(-1, 1) * d_ * 0.75
    y = CP.y + d_
    s = _hr.uniform(1.4, 3.4) * (1 + d_ / 45.0)
    if x / d_ > 0.12:
        s *= 0.72
    top = FLOOR_Z + s * 1.6
    ok = True
    for w_ in WORLD_CFG:
        if math.hypot(x - w_["x"], y - w_["y"]) < w_["R"] * w_["scale"] + s * 1.4 and top > w_["z"] - w_["D"] * w_["scale"] - 1.2:
            ok = False
            break
    if ok:
        put_heap(x, y, FLOOR_Z - s * 0.1, s, sz=_hr.uniform(0.55, 0.95))
# big cumulus towers well behind the line, on the far side from the sun
for x, y, s, sz in ((-78, 135, 26, 0.95), (-122, 205, 42, 0.9), (-34, 230, 30, 0.72), (-160, 150, 34, 0.8), (62, 240, 30, 0.55)):
    put_heap(x, y, FLOOR_Z - 2, s, sz=sz)
G.build()

# ---------- world ----------
w = bpy.data.worlds.new("sky")
bpy.context.scene.world = w
w.use_nodes = True
nt = w.node_tree
bg = nt.nodes["Background"]
tc = nt.nodes.new("ShaderNodeTexCoord")
_lp = nt.nodes.new("ShaderNodeLightPath")
_st = nt.nodes.new("ShaderNodeMapRange")
_st.inputs["To Min"].default_value = SKY_LIGHT
_st.inputs["To Max"].default_value = 1.0
nt.links.new(_lp.outputs["Is Camera Ray"], _st.inputs["Value"])
nt.links.new(sky_nodes(nt, tc.outputs["Generated"]), bg.inputs["Color"])
nt.links.new(_st.outputs[0], bg.inputs["Strength"])

# ---------- sun ----------
sun = bpy.data.lights.new("sun", "SUN")
sun.energy = 8.0
sun.color = (1.0, 0.56, 0.22)
sun.angle = math.radians(2.2)
so = bpy.data.objects.new("sun", sun)
so.rotation_euler = SUN_DIR.to_track_quat("Z", "Y").to_euler()
bpy.context.collection.objects.link(so)
rim = bpy.data.lights.new("rim", "SUN")
rim.energy = 3.4
rim.color = (1.0, 0.46, 0.14)
rim.angle = math.radians(3)
ro = bpy.data.objects.new("rim", rim)
ro.rotation_euler = RIM_DIR.to_track_quat("Z", "Y").to_euler()
bpy.context.collection.objects.link(ro)

# a warm hero light on the lead's isle, and warm bounce from the clouds, because the undersides are in view
_hm = _wc["lead"]
_hc = Vector((_hm["x"], _hm["y"], _hm["z"] + 2.2))
_hp = _hc + dir_from(-140, 16) * 38.0
_hl = bpy.data.lights.new("hero", "SPOT")
_hl.energy = 34000
_hl.color = (1.0, 0.64, 0.32)
_hl.spot_size = math.radians(18)
_hl.spot_blend = 0.9
_hl.shadow_soft_size = 1.2
_ho = bpy.data.objects.new("hero", _hl)
_ho.location = _hp
_ho.rotation_euler = (_hc - _hp).to_track_quat("-Z", "Y").to_euler()
bpy.context.collection.objects.link(_ho)
_bl = bpy.data.lights.new("bounce", "SUN")
_bl.energy = 1.1
_bl.color = (1.0, 0.66, 0.48)
_bl.angle = math.radians(40)
_bo = bpy.data.objects.new("bounce", _bl)
_bo.rotation_euler = dir_from(-150, -55).to_track_quat("Z", "Y").to_euler()
bpy.context.collection.objects.link(_bo)

# ---------- camera ----------
cd = bpy.data.cameras.new("cam")
cd.lens = LENS
cd.sensor_width = 36
co = bpy.data.objects.new("cam", cd)
co.location = CP
co.rotation_euler = (TG - CP).to_track_quat("-Z", "Y").to_euler()
bpy.context.collection.objects.link(co)
bpy.context.scene.camera = co
cd.dof.use_dof = True
cd.dof.focus_distance = 22.0
cd.dof.aperture_fstop = 0.5
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
sc.cycles.transparent_max_bounces = 32
sc.cycles.sample_clamp_direct = 24.0
sc.cycles.sample_clamp_indirect = 8.0
sc.cycles.volume_bounces = 1
sc.cycles.volume_max_steps = 256
sc.render.resolution_x = WIDTH
sc.render.resolution_y = round(WIDTH * 9 / 16)
sc.render.resolution_percentage = 100
sc.render.image_settings.file_format = "PNG"
if "--border" in ARGS:     # region of the frame for detail checks: x0,y0,x1,y1 as fractions, y up
    _b = [float(v) for v in ARGS[ARGS.index("--border") + 1].split(",")]
    sc.render.use_border = True
    sc.render.use_crop_to_border = True
    sc.render.border_min_x, sc.render.border_min_y, sc.render.border_max_x, sc.render.border_max_y = _b
sc.render.filepath = OUT
sc.view_settings.view_transform = "AgX"
sc.view_settings.look = "AgX - Punchy"
sc.view_settings.exposure = -0.05
try:
    tree_ = bpy.data.node_groups.new("post", "CompositorNodeTree")
    tree_.interface.new_socket(name="Image", in_out="OUTPUT", socket_type="NodeSocketColor")
    sc.compositing_node_group = tree_
    rl = tree_.nodes.new("CompositorNodeRLayers")
    gl = tree_.nodes.new("CompositorNodeGlare")
    gl.inputs["Type"].default_value = "Bloom"
    gl.inputs["Quality"].default_value = "High"
    for nm, val in (("Threshold", 1.0), ("Smoothness", 0.7), ("Strength", 0.42), ("Saturation", 1.2), ("Size", 0.62)):
        gl.inputs[nm].default_value = val
    ou = tree_.nodes.new("NodeGroupOutput")
    tree_.links.new(rl.outputs["Image"], gl.inputs["Image"])
    tree_.links.new(gl.outputs["Image"], ou.inputs[0])
    sc.render.use_compositing = True
except Exception as ex:
    print("POST SKIPPED", repr(ex), flush=True)
    sc.compositing_node_group = None
    sc.render.use_compositing = False
if SAVE:
    bpy.ops.wm.save_as_mainfile(filepath=SAVE)
tris = sum(len(m.polygons) for m in bpy.data.meshes)
print("objects", len(bpy.data.objects), "unique faces", tris, flush=True)
if PT.ON:
    PT.finish(co, env_center=Vector((3.0, 24.0, 2.6)))
    sys.exit(0)
bpy.ops.render.render(write_still=True)
if "--crops" in ARGS:      # x0,y0,x1,y1;... rendered at 1920 wide from this same scene
    for i_, b_ in enumerate(ARGS[ARGS.index("--crops") + 1].split(";")):
        v_ = [float(t) for t in b_.split(",")]
        sc.render.resolution_x, sc.render.resolution_y = 1920, 1080
        sc.render.use_border = True
        sc.render.use_crop_to_border = True
        sc.render.border_min_x, sc.render.border_min_y, sc.render.border_max_x, sc.render.border_max_y = v_
        sc.render.filepath = os.path.splitext(OUT)[0] + f"_c{i_}.png"
        bpy.ops.render.render(write_still=True)
print("DONE", OUT, flush=True)
