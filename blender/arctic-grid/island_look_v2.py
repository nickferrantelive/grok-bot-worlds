"""Arctic Grid v2, the ice core survey: three bots on a frozen river, work running upstream to the vault. Cycles.

Run: Blender -b --factory-startup --python island_look.py -- <out.png> <width> <samples> [save.blend] [key=value ...]
Keys: fstop=<value> lens aperture
      norender=1 stop after building and saving
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
OPT = dict(a.split("=", 1) for a in ARGS if "=" in a)
ARGS = [a for a in ARGS if "=" not in a and a != "--"]
OUT = ARGS[0] if ARGS else "/tmp/world.png"
WIDTH = int(ARGS[1]) if len(ARGS) > 1 else 1280
SAMPLES = int(ARGS[2]) if len(ARGS) > 2 else 64
SAVE = next((a for a in ARGS[3:] if a.endswith(".blend")), None)
PT.setup(ARGS, globals())
LOW_BUILD = OPT.get("low") == "1"

random.seed(11)
np.random.seed(11)
BOT = (1.0, 0.36, 0.05)      # the bot's colour, drives LEDs and character
LED = (1.0, 0.13, 0.006)
WARM = (1.0, 0.56, 0.22)
ICE_LED = (0.42, 0.78, 1.0)

for o in list(bpy.data.objects):
    bpy.data.objects.remove(o)


MAT_INFO = {}


# ---------- materials ----------
def pbsdf(name, base=(0.5, 0.5, 0.5), rough=0.5, metal=0.0, emis=None, emis_str=0.0, coat=0.0, coat_rough=0.05, sss=0.0, sss_scale=0.05):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    MAT_INFO[name] = dict(base=base, rough=rough, metal=metal, emis=emis, emis_str=emis_str)
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


def snow_nodes(nt, scale=90.0):
    """Wind-cut snow: lumps and stretched ridges, fine grain, and tiny sparkles."""
    s = nt.nodes.new("ShaderNodeBsdfPrincipled")
    s.inputs["Base Color"].default_value = (0.85, 0.9, 0.98, 1)
    s.inputs["Roughness"].default_value = 0.55
    s.inputs["Subsurface Weight"].default_value = 0.55
    s.inputs["Subsurface Radius"].default_value = (0.45, 0.7, 1.0)
    s.inputs["Subsurface Scale"].default_value = 0.025
    s.inputs["Specular IOR Level"].default_value = 0.5
    tc = nt.nodes.new("ShaderNodeTexCoord")
    lumps = nt.nodes.new("ShaderNodeTexNoise")
    lumps.inputs["Scale"].default_value = 7
    lumps.inputs["Detail"].default_value = 5
    nt.links.new(tc.outputs["Object"], lumps.inputs["Vector"])
    mp = nt.nodes.new("ShaderNodeMapping")
    mp.inputs["Rotation"].default_value = (0, 0, math.radians(35))
    mp.inputs["Scale"].default_value = (2.5, 11, 6)
    nt.links.new(tc.outputs["Object"], mp.inputs["Vector"])
    wind = nt.nodes.new("ShaderNodeTexNoise")
    wind.inputs["Scale"].default_value = 1.0
    wind.inputs["Detail"].default_value = 5
    wind.inputs["Roughness"].default_value = 0.55
    nt.links.new(mp.outputs[0], wind.inputs["Vector"])
    add = nt.nodes.new("ShaderNodeMath")
    add.operation = "MULTIPLY_ADD"
    add.inputs[1].default_value = 0.6
    nt.links.new(lumps.outputs["Fac"], add.inputs[0])
    nt.links.new(wind.outputs["Fac"], add.inputs[2])
    b1 = nt.nodes.new("ShaderNodeBump")
    b1.inputs["Strength"].default_value = 0.42
    b1.inputs["Distance"].default_value = 0.05
    nt.links.new(add.outputs[0], b1.inputs["Height"])
    fine = nt.nodes.new("ShaderNodeTexNoise")
    fine.inputs["Scale"].default_value = scale * 3
    fine.inputs["Detail"].default_value = 4
    nt.links.new(tc.outputs["Object"], fine.inputs["Vector"])
    b2 = nt.nodes.new("ShaderNodeBump")
    b2.inputs["Strength"].default_value = 0.45
    b2.inputs["Distance"].default_value = 0.006
    nt.links.new(fine.outputs["Fac"], b2.inputs["Height"])
    nt.links.new(b1.outputs["Normal"], b2.inputs["Normal"])
    nt.links.new(b2.outputs["Normal"], s.inputs["Normal"])
    # sparkle
    v = nt.nodes.new("ShaderNodeTexVoronoi")
    v.inputs["Scale"].default_value = 110
    nt.links.new(tc.outputs["Object"], v.inputs["Vector"])
    dot = nt.nodes.new("ShaderNodeValToRGB")
    dot.color_ramp.elements[0].position = 0.0
    dot.color_ramp.elements[0].color = (1, 1, 1, 1)
    dot.color_ramp.elements[1].position = 0.14
    dot.color_ramp.elements[1].color = (0, 0, 0, 1)
    nt.links.new(v.outputs["Distance"], dot.inputs["Fac"])
    sep = nt.nodes.new("ShaderNodeSeparateColor")
    nt.links.new(v.outputs["Color"], sep.inputs[0])
    gate = nt.nodes.new("ShaderNodeValToRGB")
    gate.color_ramp.elements[0].position = 0.86
    gate.color_ramp.elements[1].position = 0.9
    nt.links.new(sep.outputs["Red"], gate.inputs["Fac"])
    mu = nt.nodes.new("ShaderNodeMath")
    mu.operation = "MULTIPLY"
    nt.links.new(dot.outputs["Color"], mu.inputs[0])
    nt.links.new(gate.outputs["Color"], mu.inputs[1])
    mu2 = nt.nodes.new("ShaderNodeMath")
    mu2.operation = "MULTIPLY"
    mu2.inputs[1].default_value = 3.0
    nt.links.new(mu.outputs[0], mu2.inputs[0])
    s.inputs["Emission Color"].default_value = (1, 0.97, 0.92, 1)
    nt.links.new(mu2.outputs[0], s.inputs["Emission Strength"])
    return s


def mat_snow(name="snow", far=None):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.remove(nt.nodes["Principled BSDF"])
    s = snow_nodes(nt)
    if far:
        # the banks fall off to a darker, cooler snow behind the back row, so islands stand clear of them
        geo = nt.nodes.new("ShaderNodeNewGeometry")
        sp = nt.nodes.new("ShaderNodeSeparateXYZ")
        nt.links.new(geo.outputs["Position"], sp.inputs[0])
        mr = nt.nodes.new("ShaderNodeMapRange")
        mr.inputs["From Min"].default_value = 15.0
        mr.inputs["From Max"].default_value = 26.0
        nt.links.new(sp.outputs["Y"], mr.inputs["Value"])
        cm = nt.nodes.new("ShaderNodeMix")
        cm.data_type = "RGBA"
        cm.inputs["A"].default_value = (0.85, 0.9, 0.98, 1)
        cm.inputs["B"].default_value = (*far, 1)
        nt.links.new(mr.outputs[0], cm.inputs["Factor"])
        nt.links.new(cm.outputs["Result"], s.inputs["Base Color"])
    nt.links.new(s.outputs[0], nt.nodes["Material Output"].inputs[0])
    return m


def mat_rock():
    m = bpy.data.materials.new("rock_snow")
    m.use_nodes = True
    nt = m.node_tree
    r = nt.nodes["Principled BSDF"]
    r.inputs["Roughness"].default_value = 0.78
    tc = nt.nodes.new("ShaderNodeTexCoord")
    n1 = nt.nodes.new("ShaderNodeTexNoise")
    n1.inputs["Scale"].default_value = 3.0
    n1.inputs["Detail"].default_value = 10
    n1.inputs["Roughness"].default_value = 0.62
    nt.links.new(tc.outputs["Object"], n1.inputs["Vector"])
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    cr = ramp.color_ramp
    cr.elements[0].position, cr.elements[0].color = 0.34, (0.05, 0.054, 0.066, 1)
    cr.elements[1].position, cr.elements[1].color = 0.74, (0.36, 0.31, 0.25, 1)
    e = cr.elements.new(0.5)
    e.color = (0.14, 0.13, 0.125, 1)
    wave = nt.nodes.new("ShaderNodeTexWave")
    wave.wave_type = "BANDS"
    wave.bands_direction = "Z"
    wave.inputs["Scale"].default_value = 1.3
    wave.inputs["Distortion"].default_value = 4.0
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
    nt.links.new(fac.outputs[0], ramp.inputs["Fac"])
    crk = nt.nodes.new("ShaderNodeTexVoronoi")
    crk.feature = "DISTANCE_TO_EDGE"
    crk.inputs["Scale"].default_value = 2.8
    nt.links.new(tc.outputs["Object"], crk.inputs["Vector"])
    crr = nt.nodes.new("ShaderNodeValToRGB")
    crr.color_ramp.elements[0].position = 0.0
    crr.color_ramp.elements[0].color = (0.3, 0.3, 0.3, 1)
    crr.color_ramp.elements[1].position = 0.045
    crr.color_ramp.elements[1].color = (1, 1, 1, 1)
    nt.links.new(crk.outputs["Distance"], crr.inputs["Fac"])
    rmix = nt.nodes.new("ShaderNodeMix")
    rmix.data_type = "RGBA"
    rmix.blend_type = "MULTIPLY"
    rmix.inputs["Factor"].default_value = 1.0
    nt.links.new(ramp.outputs["Color"], rmix.inputs["A"])
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
    s = snow_nodes(nt)
    at = nt.nodes.new("ShaderNodeAttribute")
    at.attribute_name = "snow"
    n3 = nt.nodes.new("ShaderNodeTexNoise")
    n3.inputs["Scale"].default_value = 40
    n3.inputs["Detail"].default_value = 5
    nt.links.new(tc.outputs["Object"], n3.inputs["Vector"])
    mx = nt.nodes.new("ShaderNodeMath")
    mx.operation = "MULTIPLY_ADD"
    mx.inputs[1].default_value = 0.55
    nt.links.new(n3.outputs["Fac"], mx.inputs[0])
    nt.links.new(at.outputs["Fac"], mx.inputs[2])
    rp = nt.nodes.new("ShaderNodeValToRGB")
    rp.color_ramp.elements[0].position = 0.62
    rp.color_ramp.elements[1].position = 0.74
    nt.links.new(mx.outputs[0], rp.inputs["Fac"])
    mix = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(rp.outputs["Color"], mix.inputs[0])
    nt.links.new(r.outputs[0], mix.inputs[1])
    nt.links.new(s.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], nt.nodes["Material Output"].inputs[0])
    return m


def mat_pine():
    m = bpy.data.materials.new("pine")
    m.use_nodes = True
    nt = m.node_tree
    p = nt.nodes["Principled BSDF"]
    p.inputs["Roughness"].default_value = 0.75
    s = snow_nodes(nt, 60)
    at = nt.nodes.new("ShaderNodeAttribute")
    at.attribute_name = "snow"
    oi = nt.nodes.new("ShaderNodeObjectInfo")
    sp = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(oi.outputs["Location"], sp.inputs[0])
    far = nt.nodes.new("ShaderNodeMapRange")    # 0 for the corner pines and the shore, 1 deep in the forest
    far.inputs["From Min"].default_value = -6.0
    far.inputs["From Max"].default_value = 15.0
    nt.links.new(sp.outputs["Y"], far.inputs["Value"])
    bc = nt.nodes.new("ShaderNodeMix")
    bc.data_type = "RGBA"
    bc.inputs["A"].default_value = (0.016, 0.05, 0.036, 1)
    bc.inputs["B"].default_value = (0.004, 0.016, 0.024, 1)
    nt.links.new(far.outputs[0], bc.inputs["Factor"])
    nt.links.new(bc.outputs["Result"], p.inputs["Base Color"])
    sc_ = nt.nodes.new("ShaderNodeMix")
    sc_.data_type = "RGBA"
    sc_.inputs["A"].default_value = (0.85, 0.9, 0.98, 1)
    sc_.inputs["B"].default_value = (0.5, 0.42, 0.34, 1)
    nt.links.new(far.outputs[0], sc_.inputs["Factor"])
    ner = nt.nodes.new("ShaderNodeMapRange")
    ner.inputs["From Min"].default_value = -10.0
    ner.inputs["From Max"].default_value = -17.0
    nt.links.new(sp.outputs["Y"], ner.inputs["Value"])
    nc_ = nt.nodes.new("ShaderNodeMix")
    nc_.data_type = "RGBA"
    nt.links.new(ner.outputs[0], nc_.inputs["Factor"])
    nt.links.new(sc_.outputs["Result"], nc_.inputs["A"])
    nc_.inputs["B"].default_value = (0.38, 0.36, 0.36, 1)
    nt.links.new(nc_.outputs["Result"], s.inputs["Base Color"])
    tip = nt.nodes.new("ShaderNodeMapRange")
    tip.inputs["From Min"].default_value = 0.72
    tip.inputs["From Max"].default_value = 1.0
    tip.inputs["To Max"].default_value = 0.95
    nt.links.new(at.outputs["Fac"], tip.inputs["Value"])
    lerp = nt.nodes.new("ShaderNodeMapRange")
    nt.links.new(far.outputs[0], lerp.inputs["Value"])
    nt.links.new(at.outputs["Fac"], lerp.inputs["To Min"])
    nt.links.new(tip.outputs[0], lerp.inputs["To Max"])
    mix = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(lerp.outputs[0], mix.inputs[0])
    nt.links.new(p.outputs[0], mix.inputs[1])
    nt.links.new(s.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], nt.nodes["Material Output"].inputs[0])
    return m


def mat_ice():
    m = bpy.data.materials.new("ice")
    m.use_nodes = True
    nt = m.node_tree
    p = nt.nodes["Principled BSDF"]
    tc = nt.nodes.new("ShaderNodeTexCoord")
    warp = nt.nodes.new("ShaderNodeTexNoise")
    warp.inputs["Scale"].default_value = 0.8
    warp.inputs["Detail"].default_value = 4
    warpm = nt.nodes.new("ShaderNodeVectorMath")
    warpm.operation = "SCALE"
    warpm.inputs["Scale"].default_value = 1.1
    nt.links.new(warp.outputs["Color"], warpm.inputs[0])
    nt.links.new(tc.outputs["Object"], warp.inputs["Vector"])
    addv = nt.nodes.new("ShaderNodeVectorMath")
    nt.links.new(tc.outputs["Object"], addv.inputs[0])
    nt.links.new(warpm.outputs[0], addv.inputs[1])

    def cracks(scale, w0, w1):
        v = nt.nodes.new("ShaderNodeTexVoronoi")
        v.feature = "DISTANCE_TO_EDGE"
        v.inputs["Scale"].default_value = scale
        nt.links.new(addv.outputs[0], v.inputs["Vector"])
        r = nt.nodes.new("ShaderNodeValToRGB")
        r.color_ramp.elements[0].position = w0
        r.color_ramp.elements[0].color = (1, 1, 1, 1)
        r.color_ramp.elements[1].position = w1
        r.color_ramp.elements[1].color = (0, 0, 0, 1)
        brk = nt.nodes.new("ShaderNodeTexNoise")
        brk.inputs["Scale"].default_value = 2.2 * max(scale, 0.8)
        brk.inputs["Detail"].default_value = 4
        nt.links.new(tc.outputs["Object"], brk.inputs["Vector"])
        cut = nt.nodes.new("ShaderNodeMapRange")
        cut.inputs["From Min"].default_value = 0.55
        cut.inputs["From Max"].default_value = 0.72
        cut.inputs["To Min"].default_value = 0.0
        cut.inputs["To Max"].default_value = 0.05
        nt.links.new(brk.outputs["Fac"], cut.inputs["Value"])
        addd = nt.nodes.new("ShaderNodeMath")
        nt.links.new(v.outputs["Distance"], addd.inputs[0])
        nt.links.new(cut.outputs[0], addd.inputs[1])
        nt.links.new(addd.outputs[0], r.inputs["Fac"])
        return r

    c1, c2 = cracks(0.36, 0.0012, 0.0085), cracks(1.25, 0.0006, 0.006)
    gate = nt.nodes.new("ShaderNodeTexNoise")   # fine cracks fade in and out
    gate.inputs["Scale"].default_value = 0.6
    nt.links.new(tc.outputs["Object"], gate.inputs["Vector"])
    gr = nt.nodes.new("ShaderNodeValToRGB")
    gr.color_ramp.elements[0].position = 0.46
    gr.color_ramp.elements[1].position = 0.6
    nt.links.new(gate.outputs["Fac"], gr.inputs["Fac"])
    ml = nt.nodes.new("ShaderNodeMath")
    ml.operation = "MULTIPLY"
    nt.links.new(c2.outputs["Color"], ml.inputs[0])
    nt.links.new(gr.outputs["Color"], ml.inputs[1])
    mxm = nt.nodes.new("ShaderNodeMath")
    mxm.operation = "MAXIMUM"
    nt.links.new(c1.outputs["Color"], mxm.inputs[0])
    nt.links.new(ml.outputs[0], mxm.inputs[1])
    # depth colour: dark clear ice with paler milky clouds
    cl = nt.nodes.new("ShaderNodeTexNoise")
    cl.inputs["Scale"].default_value = 1.3
    cl.inputs["Detail"].default_value = 9
    cl.inputs["Roughness"].default_value = 0.6
    nt.links.new(tc.outputs["Object"], cl.inputs["Vector"])
    cr = nt.nodes.new("ShaderNodeValToRGB")
    cr.color_ramp.elements[0].position = 0.38
    cr.color_ramp.elements[0].color = (0.012, 0.05, 0.08, 1)
    cr.color_ramp.elements[1].position = 0.8
    cr.color_ramp.elements[1].color = (0.05, 0.14, 0.205, 1)
    nt.links.new(cl.outputs["Fac"], cr.inputs["Fac"])
    # trapped bubbles in pale drifts
    bb = nt.nodes.new("ShaderNodeTexVoronoi")
    bb.inputs["Scale"].default_value = 46
    nt.links.new(tc.outputs["Object"], bb.inputs["Vector"])
    bbr = nt.nodes.new("ShaderNodeValToRGB")
    bbr.color_ramp.elements[0].position = 0.03
    bbr.color_ramp.elements[0].color = (0.55, 0.55, 0.55, 1)
    bbr.color_ramp.elements[1].position = 0.11
    bbr.color_ramp.elements[1].color = (0, 0, 0, 1)
    nt.links.new(bb.outputs["Distance"], bbr.inputs["Fac"])
    bg_ = nt.nodes.new("ShaderNodeTexNoise")
    bg_.inputs["Scale"].default_value = 1.1
    bg_.inputs["Detail"].default_value = 3
    nt.links.new(tc.outputs["Object"], bg_.inputs["Vector"])
    bgr = nt.nodes.new("ShaderNodeValToRGB")
    bgr.color_ramp.elements[0].position = 0.5
    bgr.color_ramp.elements[1].position = 0.62
    nt.links.new(bg_.outputs["Fac"], bgr.inputs["Fac"])
    bbm = nt.nodes.new("ShaderNodeMath")
    bbm.operation = "MULTIPLY"
    nt.links.new(bbr.outputs["Color"], bbm.inputs[0])
    nt.links.new(bgr.outputs["Color"], bbm.inputs[1])
    # crack brightness varies along its length
    vary = nt.nodes.new("ShaderNodeTexNoise")
    vary.inputs["Scale"].default_value = 3.4
    nt.links.new(tc.outputs["Object"], vary.inputs["Vector"])
    vr = nt.nodes.new("ShaderNodeMapRange")
    vr.inputs["From Min"].default_value = 0.35
    vr.inputs["From Max"].default_value = 0.65
    vr.inputs["To Min"].default_value = 0.28
    vr.inputs["To Max"].default_value = 0.9
    nt.links.new(vary.outputs["Fac"], vr.inputs["Value"])
    crf = nt.nodes.new("ShaderNodeMath")
    crf.operation = "MULTIPLY"
    nt.links.new(mxm.outputs[0], crf.inputs[0])
    nt.links.new(vr.outputs[0], crf.inputs[1])
    fin = nt.nodes.new("ShaderNodeMath")
    fin.operation = "MAXIMUM"
    nt.links.new(crf.outputs[0], fin.inputs[0])
    nt.links.new(bbm.outputs[0], fin.inputs[1])
    col = nt.nodes.new("ShaderNodeMix")
    col.data_type = "RGBA"
    nt.links.new(fin.outputs[0], col.inputs["Factor"])
    nt.links.new(cr.outputs["Color"], col.inputs["A"])
    col.inputs["B"].default_value = (0.62, 0.78, 0.9, 1)
    mpf = nt.nodes.new("ShaderNodeMapping")
    mpf.inputs["Rotation"].default_value = (0, 0, math.radians(32))
    mpf.inputs["Scale"].default_value = (0.42, 0.95, 1)
    nt.links.new(tc.outputs["Object"], mpf.inputs["Vector"])
    nfr = nt.nodes.new("ShaderNodeTexNoise")
    nfr.inputs["Scale"].default_value = 1.0
    nfr.inputs["Detail"].default_value = 6
    nfr.inputs["Roughness"].default_value = 0.62
    nt.links.new(mpf.outputs[0], nfr.inputs["Vector"])
    rfr = nt.nodes.new("ShaderNodeValToRGB")
    rfr.color_ramp.elements[0].position = 0.52
    rfr.color_ramp.elements[1].position = 0.78
    nt.links.new(nfr.outputs["Fac"], rfr.inputs["Fac"])
    frf = nt.nodes.new("ShaderNodeMath")
    frf.operation = "MULTIPLY"
    frf.inputs[1].default_value = 0.42
    nt.links.new(rfr.outputs["Color"], frf.inputs[0])
    col2 = nt.nodes.new("ShaderNodeMix")
    col2.data_type = "RGBA"
    nt.links.new(frf.outputs[0], col2.inputs["Factor"])
    nt.links.new(col.outputs["Result"], col2.inputs["A"])
    col2.inputs["B"].default_value = (0.42, 0.52, 0.62, 1)
    nt.links.new(col2.outputs["Result"], p.inputs["Base Color"])
    rg = nt.nodes.new("ShaderNodeMapRange")
    rg.inputs["To Min"].default_value = 0.085
    rg.inputs["To Max"].default_value = 0.2
    nt.links.new(cl.outputs["Fac"], rg.inputs["Value"])
    mxr = nt.nodes.new("ShaderNodeMath")
    mxr.operation = "MAXIMUM"
    mult = nt.nodes.new("ShaderNodeMath")
    mult.operation = "MULTIPLY"
    mult.inputs[1].default_value = 0.8
    nt.links.new(mxm.outputs[0], mult.inputs[0])
    nt.links.new(rg.outputs[0], mxr.inputs[0])
    nt.links.new(mult.outputs[0], mxr.inputs[1])
    mxf = nt.nodes.new("ShaderNodeMath")
    mxf.operation = "MAXIMUM"
    frr = nt.nodes.new("ShaderNodeMath")
    frr.operation = "MULTIPLY"
    frr.inputs[1].default_value = 0.62
    nt.links.new(rfr.outputs["Color"], frr.inputs[0])
    nt.links.new(mxr.outputs[0], mxf.inputs[0])
    nt.links.new(frr.outputs[0], mxf.inputs[1])
    nt.links.new(mxf.outputs[0], p.inputs["Roughness"])
    inv = nt.nodes.new("ShaderNodeMath")
    inv.operation = "MULTIPLY"
    inv.inputs[1].default_value = -1
    nt.links.new(mxm.outputs[0], inv.inputs[0])
    bp = nt.nodes.new("ShaderNodeBump")
    bp.inputs["Strength"].default_value = 0.55
    bp.inputs["Distance"].default_value = 0.012
    nt.links.new(inv.outputs[0], bp.inputs["Height"])
    nt.links.new(bp.outputs["Normal"], p.inputs["Normal"])
    return m


def mat_steam():
    m = bpy.data.materials.new("steam")
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.remove(nt.nodes["Principled BSDF"])
    v = nt.nodes.new("ShaderNodeVolumePrincipled")
    v.inputs["Color"].default_value = (0.95, 0.96, 1, 1)
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(tc.outputs["Generated"], sep.inputs[0])
    n = nt.nodes.new("ShaderNodeTexNoise")
    n.inputs["Scale"].default_value = 5.5
    n.inputs["Detail"].default_value = 7
    nt.links.new(tc.outputs["Object"], n.inputs["Vector"])
    r = nt.nodes.new("ShaderNodeValToRGB")
    r.color_ramp.elements[0].position = 0.5
    r.color_ramp.elements[1].position = 0.82
    nt.links.new(n.outputs["Fac"], r.inputs["Fac"])
    # fade towards the top and sides of the box
    grad = nt.nodes.new("ShaderNodeTexGradient")
    grad.gradient_type = "SPHERICAL"
    mp = nt.nodes.new("ShaderNodeMapping")
    mp.inputs["Location"].default_value = (0, 0, 0.25)
    mp.inputs["Scale"].default_value = (2.0, 2.0, 0.85)
    nt.links.new(tc.outputs["Object"], mp.inputs["Vector"])
    nt.links.new(mp.outputs[0], grad.inputs["Vector"])
    mu = nt.nodes.new("ShaderNodeMath")
    mu.operation = "MULTIPLY"
    nt.links.new(r.outputs["Color"], mu.inputs[0])
    nt.links.new(grad.outputs["Fac"], mu.inputs[1])
    mu2 = nt.nodes.new("ShaderNodeMath")
    mu2.operation = "MULTIPLY"
    mu2.inputs[1].default_value = 3.2
    nt.links.new(mu.outputs[0], mu2.inputs[0])
    nt.links.new(mu2.outputs[0], v.inputs["Density"])
    nt.links.new(v.outputs[0], nt.nodes["Material Output"].inputs["Volume"])
    return m


def mat_aurora():
    """A curtain of light, hanging over the far trees. Rays run up it, the lower edge melts away, and it lets the forest show through."""
    m = bpy.data.materials.new("aurora")
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    add = nt.nodes.new("ShaderNodeAddShader")
    tr = nt.nodes.new("ShaderNodeBsdfTransparent")
    em = nt.nodes.new("ShaderNodeEmission")
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sp = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(tc.outputs["Object"], sp.inputs[0])
    mp = nt.nodes.new("ShaderNodeMapping")
    mp.inputs["Scale"].default_value = (0.42, 0.42, 0.02)
    nt.links.new(tc.outputs["Object"], mp.inputs["Vector"])
    nz = nt.nodes.new("ShaderNodeTexNoise")
    nz.inputs["Scale"].default_value = 3.1
    nz.inputs["Detail"].default_value = 4
    nt.links.new(mp.outputs[0], nz.inputs["Vector"])
    rr = nt.nodes.new("ShaderNodeValToRGB")
    rr.color_ramp.elements[0].position = 0.4
    rr.color_ramp.elements[0].color = (0.16, 0.16, 0.16, 1)
    rr.color_ramp.elements[1].position = 0.72
    nt.links.new(nz.outputs["Fac"], rr.inputs["Fac"])
    lo = nt.nodes.new("ShaderNodeMapRange")
    lo.interpolation_type = "SMOOTHSTEP"
    lo.inputs["From Min"].default_value = AURORA_Z0 - 0.4
    lo.inputs["From Max"].default_value = AURORA_Z0 + 5.0
    nt.links.new(sp.outputs["Z"], lo.inputs["Value"])
    mul = nt.nodes.new("ShaderNodeMath")
    mul.operation = "MULTIPLY"
    nt.links.new(rr.outputs["Color"], mul.inputs[0])
    nt.links.new(lo.outputs[0], mul.inputs[1])
    st = nt.nodes.new("ShaderNodeMath")
    st.operation = "MULTIPLY"
    st.inputs[1].default_value = AURORA_STR
    nt.links.new(mul.outputs[0], st.inputs[0])
    nt.links.new(st.outputs[0], em.inputs["Strength"])
    hue = nt.nodes.new("ShaderNodeMapRange")
    hue.inputs["From Min"].default_value = AURORA_Z0
    hue.inputs["From Max"].default_value = AURORA_Z0 + 9.0
    nt.links.new(sp.outputs["Z"], hue.inputs["Value"])
    cr = nt.nodes.new("ShaderNodeValToRGB")
    cr.color_ramp.elements[0].color = (0.06, 1.0, 0.52, 1)
    cr.color_ramp.elements[1].color = (0.22, 0.34, 1.0, 1)
    nt.links.new(hue.outputs[0], cr.inputs["Fac"])
    nt.links.new(cr.outputs["Color"], em.inputs["Color"])
    nt.links.new(tr.outputs[0], add.inputs[0])
    nt.links.new(em.outputs[0], add.inputs[1])
    nt.links.new(add.outputs[0], out.inputs["Surface"])
    return m


AURORA_Z0 = 8.7
AURORA_STR = 0.62

MATS = dict(
    aurora=mat_aurora(),
    edge_ice=pbsdf("edge_ice", (0, 0, 0), 0.4, emis=ICE_LED, emis_str=2.4),
    tool_steel=pbsdf("tool_steel", (0.5, 0.52, 0.56), 0.3, metal=1.0),
    tool_grip=pbsdf("tool_grip", (0.015, 0.015, 0.018), 0.6),
    socket=pbsdf("socket", (0.012, 0.014, 0.018), 0.42, metal=0.5),
    snow=mat_snow(), rock=mat_rock(), pine=mat_pine(), ice=mat_ice(), steam=mat_steam(),
    tower=pbsdf("tower", (0.016, 0.019, 0.025), 0.34, metal=0.85),
    tower2=pbsdf("tower2", (0.032, 0.036, 0.046), 0.5, metal=0.6),
    steel=pbsdf("steel", (0.32, 0.34, 0.38), 0.38, metal=1.0),
    rail=pbsdf("rail", (0.05, 0.055, 0.065), 0.5, metal=0.7),
    concrete=pbsdf("concrete", (0.16, 0.165, 0.18), 0.82),
    panel=pbsdf("panel", (0.74, 0.77, 0.8), 0.32, coat=0.4),
    panel_blue=pbsdf("panel_blue", (0.03, 0.14, 0.42), 0.28, coat=0.6),
    glass=pbsdf("glass", (0.012, 0.016, 0.024), 0.08, coat=1.0),
    led_on=pbsdf("led_on", (0, 0, 0), 0.4, emis=LED, emis_str=3.1),
    led_hot=pbsdf("led_hot", (0, 0, 0), 0.4, emis=(1.0, 0.34, 0.06), emis_str=5.5),
    dent=pbsdf("dent", (0.5, 0.58, 0.74), 0.8),
    led_dim=pbsdf("led_dim", (0, 0, 0), 0.4, emis=LED, emis_str=1.2),
    led_off=pbsdf("led_off", (0.02, 0.012, 0.01), 0.3),
    seam=pbsdf("seam", (0, 0, 0), 0.4, emis=ICE_LED, emis_str=7),
    window=pbsdf("window", (0, 0, 0), 0.2, emis=(1.0, 0.46, 0.13), emis_str=3.4),
    lamp=pbsdf("lamp", (0, 0, 0), 0.3, emis=(1.0, 0.62, 0.26), emis_str=26),
    beacon=pbsdf("beacon", (0, 0, 0), 0.3, emis=(1.0, 0.07, 0.04), emis_str=26),
    crate=pbsdf("crate", (0.42, 0.48, 0.52), 0.42, coat=0.3),
    crate2=pbsdf("crate2", (0.2, 0.25, 0.27), 0.55),
    rubber=pbsdf("rubber", (0.012, 0.012, 0.014), 0.72),
    icicle=pbsdf("icicle", (0.7, 0.86, 0.98), 0.08, coat=1.0),
    bot=pbsdf("bot", BOT, mascots.GLOSSY["roughness"], coat=mascots.GLOSSY["coat"], coat_rough=mascots.GLOSSY["coat_roughness"], sss=mascots.GLOSSY["sss"], sss_scale=mascots.GLOSSY["sss_scale"] * 0.82),
    eye=pbsdf("eye", mascots.EYE_MATERIAL["base"], mascots.EYE_MATERIAL["roughness"], coat=mascots.EYE_MATERIAL["coat"], coat_rough=mascots.EYE_MATERIAL["coat_roughness"]),
    catch=pbsdf("catch", (1, 1, 1), 0.3, emis=(1, 1, 1), emis_str=2.5),
    dome=pbsdf("dome", (0.55, 0.85, 0.62), 0.12, emis=(0.5, 1.0, 0.45), emis_str=0.55, coat=1.0),
    leaf=pbsdf("leaf", (0.05, 0.3, 0.06), 0.6, emis=(0.25, 0.9, 0.2), emis_str=0.5),
    flake=pbsdf("flake", (0.9, 0.93, 1.0), 0.5, emis=(0.8, 0.88, 1.0), emis_str=0.9),
    orb=pbsdf("orb", (0, 0, 0), 0.2, emis=(1.0, 0.55, 0.16), emis_str=12),
    # the lead's vault is dark insulated steel, so the only warm thing on it is the honeycomb
    main_frame=pbsdf("main_frame", (0.62, 0.17, 0.045), 0.42, coat=0.3),
    main_trim=pbsdf("main_trim", (0.05, 0.05, 0.055), 0.38, metal=0.7),
    glass_main=pbsdf("glass_main", (0.006, 0.012, 0.02), 0.09, coat=1.0),
    win_warm=pbsdf("win_warm", (0, 0, 0), 0.25, emis=(1.0, 0.26, 0.03), emis_str=2.2),
    win_warm2=pbsdf("win_warm2", (0, 0, 0), 0.25, emis=(1.0, 0.5, 0.2), emis_str=0.6),
    plinth=pbsdf("plinth", (0.012, 0.014, 0.02), 0.32, metal=0.6, coat=0.5),
    # props that each belong to one world
    timber=pbsdf("timber", (0.27, 0.13, 0.055), 0.7),
    timber2=pbsdf("timber2", (0.09, 0.05, 0.03), 0.8),
    white_paint=pbsdf("white_paint", (0.8, 0.82, 0.84), 0.34, coat=0.3),
    solar=pbsdf("solar", (0.006, 0.02, 0.07), 0.1, metal=0.4, coat=1.0),
    crane_y=pbsdf("crane_y", (0.9, 0.48, 0.03), 0.4, coat=0.3),
    snow_bank=mat_snow("snow_bank", far=(0.42, 0.5, 0.64)),
    core_a=pbsdf("core_a", (0.56, 0.84, 1.0), 0.16, coat=0.8, sss=0.5, sss_scale=0.06, emis=(0.5, 0.82, 1.0), emis_str=0.12),
    core_b=pbsdf("core_b", (0.07, 0.3, 0.46), 0.2, coat=0.8),
    core_c=pbsdf("core_c", (0.5, 0.34, 0.2), 0.3, coat=0.5),
    cell_a=pbsdf("cell_a", (0, 0, 0), 0.75, emis=(1.0, 0.24, 0.012), emis_str=1.15),
    cell_b=pbsdf("cell_b", (0, 0, 0), 0.75, emis=(1.0, 0.32, 0.025), emis_str=1.7),
    cell_c=pbsdf("cell_c", (0, 0, 0), 0.75, emis=(1.0, 0.18, 0.007), emis_str=0.75),
)


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


MATS.update(mascots.prop_materials(pbsdf, size=1.4))
for _name, _amt in (("panel", 0.42), ("panel_blue", 0.4), ("concrete", 0.55), ("tower2", 0.5), ("crate", 0.45), ("crate2", 0.5), ("steel", 0.45), ("main_frame", 0.26), ("timber", 0.45), ("white_paint", 0.2)):
    grime(MATS[_name], _amt)


# ---------- the cheap twin: same placement, no bevels, far fewer segments ----------
# Goes to the real-time pack. The full mesh stays the source of its light (selected to active bake).
LED_MATS = {"led_on": 3.1, "led_hot": 5.5, "led_dim": 1.2, "led_off": 0.0}
GLOW_MATS = {"lamp", "beacon", "window", "seam", "catch", "orb"}
LIVE_MATS = {"bot_body", "eye", "catch", "orb"}


class LowSet:
    def __init__(self):
        self.atlas = []    # (mat, V, F, S)
        self.flat = []     # (mat, V, F)
        self.led = []      # (V(4 corners), normal, floor, level, hot, cell u, cell v)
        self.windsock = []
        self.floor = -1
        self.c = (0.0, 0.0)
        self.cell = (0.0, 0.0)


LOW = None


def _low_live():
    return LOW is not None and not G.skip


def _low_flat_box(c, size, R):
    V = np.array([(sx, sy, sz) for sz in (-.5, .5) for sy in (-.5, .5) for sx in (-.5, .5)]) * np.asarray(size)
    F = [(0, 2, 3, 1), (4, 5, 7, 6), (0, 1, 5, 4), (2, 6, 7, 3), (0, 4, 6, 2), (1, 3, 7, 5)]
    return V @ R.T + np.asarray(c), F


def low_box(mat, c, size, rz, rx, ry):
    if not _low_live() or mat in LIVE_MATS:
        return
    size = np.asarray(size, float)
    R = _rot(rz, rx, ry)
    if mat in LED_MATS:
        ax = int(np.argmin(size))
        nrm = R[:, ax].copy()
        if float(np.dot(nrm[:2], np.asarray(c)[:2] - np.asarray(LOW.c))) < 0:
            nrm = -nrm
        u, v = [i for i in range(3) if i != ax]
        cc = np.asarray(c, float) + nrm * size[ax] / 2
        du, dv = R[:, u] * size[u] / 2, R[:, v] * size[v] / 2
        quad = np.array((cc - du - dv, cc + du - dv, cc + du + dv, cc - du + dv))
        if float(np.dot(np.cross(quad[1] - quad[0], quad[3] - quad[0]), nrm)) < 0:
            quad = quad[[0, 3, 2, 1]]
        LOW.led.append((quad, nrm, LOW.floor, LED_MATS[mat], 1.0 if mat == "led_hot" else 0.0, LOW.cell[0], LOW.cell[1]))
        return
    d = np.sort(size)[::-1]
    if mat in GLOW_MATS:
        V, F = _low_flat_box(c, size, R)
        LOW.flat.append((mat, V, F))
        return
    if d[0] < 0.05 or (d[0] < 0.14 and d[1] < 0.03):    # lost to the light bake, painted on what is behind
        return
    V, F = _low_flat_box(c, size, R)
    if d[1] < 0.03:
        LOW.flat.append((mat, V, F))
    else:
        LOW.atlas.append((mat, V, F, [False] * len(F)))


def low_cyl(mat, a, b, r, seg, cap, r2):
    if not _low_live() or mat in LIVE_MATS and mat != "bot":
        return
    L = float(np.linalg.norm(np.asarray(b, float) - np.asarray(a, float)))
    if r < 0.0025 or (r < 0.006 and L < 0.1) or (L < 0.012):
        return
    if mat == "icicle" and L < 0.05:
        return
    a, b = np.asarray(a, float), np.asarray(b, float)
    d = b - a
    d /= np.linalg.norm(d) + 1e-9
    u = np.cross(d, (0, 0, 1) if abs(d[2]) < 0.9 else (1, 0, 0))
    u /= np.linalg.norm(u) + 1e-9
    w = np.cross(d, u)
    thick = r >= 0.03
    n = max(10, seg // 3) if r >= 0.2 else (8 if thick else 3)
    t = np.linspace(0, 2 * np.pi, n, endpoint=False)
    ring = np.outer(np.cos(t), u) + np.outer(np.sin(t), w)
    V = np.vstack((a + ring * r, b + ring * (r if r2 is None else r2)))
    F = [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
    if mat in GLOW_MATS or not thick:
        LOW.flat.append((mat, V, F))
        return
    S = [True] * n
    if cap:
        F += [tuple(range(n - 1, -1, -1)), tuple(range(n, 2 * n))]
        S += [False, False]
    LOW.atlas.append((mat, V, F, S))


def low_sphere(mat, c, r, seg, rings, sc, rz, rx):
    if not _low_live() or mat in LIVE_MATS:
        return
    if r * max(sc) < 0.02 and mat not in GLOW_MATS:
        return
    if r * min(sc) < 0.012 and mat not in GLOW_MATS:
        return
    if mat in GLOW_MATS:
        n, rr = 4, 2
    else:
        n, rr = max(6, seg // 2), max(3, rings // 2)
    V, F = [], []
    for j in range(rr + 1):
        p = math.pi * j / rr
        for i in range(n):
            t = 2 * math.pi * i / n
            V.append((math.sin(p) * math.cos(t) * sc[0], math.sin(p) * math.sin(t) * sc[1], math.cos(p) * sc[2]))
    for j in range(rr):
        for i in range(n):
            a, b = j * n + i, j * n + (i + 1) % n
            F.append((a, a + n, b + n, b))
    V = np.array(V) * r @ _rot(rz, rx).T + np.asarray(c)
    if mat in GLOW_MATS:
        LOW.flat.append((mat, V, F))
    else:
        LOW.atlas.append((mat, V, F, [True] * len(F)))


def low_lathe(mat, c, prof, seg, rx, rz):
    if not _low_live() or mat in LIVE_MATS:
        return
    ext = max(p[0] for p in prof)
    span = max(abs(a[0] - b[0]) + abs(a[1] - b[1]) for a, b in zip(prof, prof[1:]))
    if span < 0.018 and mat not in LED_MATS:
        return
    n = max(8, seg // 3) if ext > 0.15 else 6
    prof2 = prof if len(prof) <= 5 else prof[:: max(1, len(prof) // 5)] + [prof[-1]]
    V, F = [], []
    for r, z in prof2:
        for i in range(n):
            t = 2 * math.pi * i / n
            V.append((r * math.cos(t), r * math.sin(t), z))
    for j in range(len(prof2) - 1):
        for i in range(n):
            a, b = j * n + i, j * n + (i + 1) % n
            F.append((a, b, b + n, a + n))
    if mat == "panel" and prof[0][0] < prof[-1][0]:
        F = [tuple(reversed(f)) for f in F]
    V = np.array(V) @ _rot(rz, rx).T + np.asarray(c)
    if mat in LED_MATS:
        for f in F:
            q = V[list(f)]
            nrm = np.cross(q[1] - q[0], q[3] - q[0])
            nrm /= np.linalg.norm(nrm) + 1e-9
            LOW.led.append((q, nrm, -1, LED_MATS[mat], 1.0 if mat == "led_hot" else 0.0, 0.0, 0.0))
    else:
        LOW.atlas.append((mat, V, F, [True] * len(F)))


def low_pillow(c, sx, sy, h, n, rz, over, mat):
    if not _low_live() or max(sx, sy) < 0.14:
        return
    m = max(2, n // 4)
    sx, sy = sx * over, sy * over
    V, F = [], []
    for j in range(m + 1):
        for i in range(m + 1):
            u, v = -1 + 2 * i / m, -1 + 2 * j / m
            k = 1 - (1 - abs(u) ** 5) * (1 - abs(v) ** 5)
            top = h * (1 - k ** 1.4) ** 0.6
            V.append((u * sx / 2, v * sy / 2, max(top, 0) - h * 0.04))
    for j in range(m):
        for i in range(m):
            a = j * (m + 1) + i
            F.append((a, a + 1, a + m + 2, a + m + 1))
    LOW.atlas.append((mat, np.array(V) @ _rot(rz).T + np.asarray(c), F, [True] * len(F)))


def low_direct(mat, V, F, S):
    if _low_live():
        LOW.atlas.append((mat, np.asarray(V, float), F, S))


# ---------- geometry ----------
class Geo:
    def __init__(self):
        self.d = {}
        self.skip = False

    def add(self, mat, V, F, S):
        if self.skip:
            return
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
    low_box(mat, c, size, rz, rx, ry)


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
    low_cyl(mat, a, b, r, seg, cap, r2)


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
    low_sphere(mat, c, r, seg, rings, sc, rz, rx)


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
    low_lathe(mat, c, prof, seg, rx, rz)


def pillow(c, sx, sy, h, n=12, rz=0.0, over=1.04, mat="snow"):
    """A soft snow cap: rounded in plan and in section, slightly lumpy."""
    low_pillow(c, sx, sy, h, n, rz, over, mat)
    sx, sy = sx * over, sy * over
    V, F = [], []
    seed = random.uniform(0, 100)
    for j in range(n + 1):
        for i in range(n + 1):
            u, v = -1 + 2 * i / n, -1 + 2 * j / n
            # map square to a soft rounded rectangle
            k = 1 - (1 - abs(u) ** 5) * (1 - abs(v) ** 5)
            top = h * (1 - k ** 1.4) ** 0.6 * (1 + 0.35 * noise.noise(Vector((u * 2.2 * sx + seed, v * 2.2 * sy, seed))))
            V.append((u * sx / 2, v * sy / 2, max(top, 0) - h * 0.04))
    for j in range(n):
        for i in range(n):
            a = j * (n + 1) + i
            F.append((a, a + 1, a + n + 2, a + n + 1))
    G.add(mat, np.array(V) @ _rot(rz).T + np.asarray(c), F, [True] * len(F))


def icicles(a, b, n, lmax=0.11):
    a, b = np.asarray(a, float), np.asarray(b, float)
    for i in range(n):
        t = (i + random.random()) / n
        if random.random() < 0.25:
            continue
        p = a + (b - a) * t
        L = random.uniform(0.25, 1) ** 2 * lmax
        cyl("icicle", p, p - np.array((0, 0, L)), 0.012 * (0.5 + L / lmax), seg=6, cap=False, r2=0.0008)


# ---------- rock ----------
def mesh_obj(name, V, F, mat, attr=None, smooth=True):
    me = bpy.data.meshes.new(name)
    me.from_pydata(V.tolist() if hasattr(V, "tolist") else V, [], F)
    if smooth:
        me.polygons.foreach_set("use_smooth", [True] * len(me.polygons))
    if attr is not None:
        a = me.attributes.new("snow", "FLOAT", "POINT")
        a.data.foreach_set("value", attr)
    me.update()
    me.materials.append(MATS[mat])
    o = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(o)
    if LOW is not None:
        LOW_BIG.append((o, mat))
    return o


LOW_BIG = []
PLATEAU_R, PLATEAU_Z = 2.75, 1.34


def build_rock(seed=0.0):
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=7, radius=1.0)
    V = np.array([v.co[:] for v in bm.verts])
    idx = {v: i for i, v in enumerate(bm.verts)}
    F = [tuple(idx[v] for v in f.verts) for f in bm.faces]
    bm.free()
    P = np.zeros_like(V)
    t0 = 0.0
    for i, (x, y, z) in enumerate(V):
        r = math.hypot(x, y)
        ang = math.atan2(y, x)
        # superquadric mesa
        rr = (r ** 0.52) * (3.3 + 0.42 * math.sin(ang * 3.0 + 1.0 + seed) + 0.2 * math.sin(ang * 5.0 + 2.4 + seed * 2.0))
        zz = PLATEAU_Z * (abs(z) ** 0.36) * (1 if z > 0 else -0.45)
        v = Vector((rr * math.cos(ang), rr * math.sin(ang), zz))
        n1 = noise.fractal(v * 0.75 + Vector((3.1 + seed, 7.7, 1.3)), 1.0, 2.1, 5)
        n2 = noise.ridged_multi_fractal(v * 1.5 + Vector((seed, 0, 0)), 1.0, 2.2, 5, 1.0, 2.0)
        strata = ((zz * 5.2 + n1 * 1.4) % 1.0)
        n4 = noise.fractal(v * 7.0, 1.0, 2.1, 3)
        edge = min(max((rr - 2.55) / 0.8, 0.0), 1.0)    # no terraces on the flat top
        scale = 1.0 + edge * (0.24 * n1 + 0.055 * (n2 - 0.7) - 0.115 * strata + 0.022 * n4)
        hx, hy = rr * scale * math.cos(ang), rr * scale * math.sin(ang)
        hz = zz + edge * (0.13 * n1 + 0.05 * (n2 - 0.7) + 0.02 * n4)
        # press a flat pad for the base
        pad = min(max((math.hypot(hx, hy) - (PLATEAU_R - 0.25)) / 0.5, 0.0), 1.0)
        if z > 0:
            hz = PLATEAU_Z * (1 - pad) + hz * pad + (1 - pad) * 0.015 * n1
        P[i] = (hx, hy, hz)
    # normals + snow mask via a temporary mesh
    me = bpy.data.meshes.new("tmp")
    me.from_pydata(P.tolist(), [], F)
    me.update()
    N = np.zeros((len(P), 3))
    me.vertices.foreach_get("normal", N.ravel())
    bpy.data.meshes.remove(me)
    snow = np.clip((N[:, 2] - 0.58) / 0.24, 0, 1)
    P = P + N * (0.05 * snow)[:, None]
    o = mesh_obj("rock", P, F, "rock", attr=snow.astype(np.float32))
    tris = []
    for f in F:
        tris.append(f)
    bvh = BVHTree.FromPolygons(P.tolist(), tris)
    return o, bvh


BVH = None


def rock_z(x, y, default=0.0):
    hit = BVH.ray_cast(Vector((x, y, 8)), Vector((0, 0, -1)))
    return hit[0].z if hit[0] is not None else default


# Where a station's local point lands in the world, for spots and pivots.
CUR_ST = dict(x=0.0, y=0.0, z=0.0, yaw=0.0, sc=1.0, key=None)
BOT_KEYS = dict(orange="drill", pink="tow", main="lead")


def st_world(p):
    c, s_ = math.cos(CUR_ST["yaw"]), math.sin(CUR_ST["yaw"])
    x, y, z = float(p[0]) * CUR_ST["sc"], float(p[1]) * CUR_ST["sc"], float(p[2]) * CUR_ST["sc"]
    return (CUR_ST["x"] + x * c - y * s_, CUR_ST["y"] + x * s_ + y * c, CUR_ST["z"] + z)


def prism(mat, pts, y0, y1):
    """A flat shape in x and z, counter clockwise, pushed out along y. Hard edges, so a tool keeps its silhouette."""
    n_ = len(pts)
    V = [(x, y0, z) for x, z in pts] + [(x, y1, z) for x, z in pts]
    F = [tuple(range(n_)), tuple(range(2 * n_ - 1, n_ - 1, -1))] + [(i, n_ + i, n_ + (i + 1) % n_, (i + 1) % n_) for i in range(n_)]
    G.add(mat, np.array(V, float), F, [False] * len(F))


def wrench_unit():
    """An open jaw spanner at the size of a bot. The notch and the flat bar are what stop it reading as a bone."""
    t_ = 0.042
    R0, w_ = 0.21, 0.092
    a0 = math.asin(w_ / R0)
    tip = R0 * math.cos(a0)
    head = [(tip, w_)] + [(R0 * math.cos(a), R0 * math.sin(a)) for a in np.linspace(a0, 2 * math.pi - a0, 22)[1:-1]] + [(tip, -w_), (-0.03, -w_), (-0.075, 0.0), (-0.03, w_)]
    jaw = math.radians(62)
    cj, sj = math.cos(jaw), math.sin(jaw)
    hz = 0.5
    prism("tool_steel", [(x * cj - z * sj, hz + x * sj + z * cj) for x, z in head], -t_, t_)
    prism("tool_steel", [(-0.05, -0.46), (0.05, -0.46), (0.066, hz - 0.1), (-0.066, hz - 0.1)], -t_ * 0.72, t_ * 0.72)
    prism("tool_grip", [(-0.06, -0.3), (0.06, -0.3), (0.066, 0.2), (-0.066, 0.2)], -t_ * 1.08, t_ * 1.08)
    # the ring at the far end
    ang = np.linspace(0, 2 * math.pi, 15)
    for a, b in zip(ang, ang[1:]):
        q = [(0.135 * math.cos(a), -0.55 + 0.135 * math.sin(a)), (0.135 * math.cos(b), -0.55 + 0.135 * math.sin(b)), (0.07 * math.cos(b), -0.55 + 0.07 * math.sin(b)), (0.07 * math.cos(a), -0.55 + 0.07 * math.sin(a))]
        prism("tool_steel", q, -t_, t_)


# ---------- the bots: the body shapes from the brand art ----------
def bot(c, s, shape="squircle", facing=math.radians(18), tool=None, **tool_kw):
    if PT.ON:
        PT.bot(BOT_KEYS[CUR_ST["key"]], st_world((c[0], c[1], c[2] - 0.47 * s)), s * CUR_ST["sc"], yaw=facing + CUR_ST["yaw"], shape=shape, tool=tool)
        return
    m = mascots.placed_mesh(shape, size=s, base=(c[0], c[1], c[2] - 0.47 * s), facing=facing, pitch=math.radians(-7))
    if tool:
        for part in mascots.placed_prop(tool, shape=shape, size=s, base=(c[0], c[1], c[2] - 0.47 * s), facing=facing, pitch=math.radians(-7), **tool_kw):
            G.add(part["mat"], part["v"], part["f"], [True] * len(part["f"]))
    # bot_body keeps the body its own material, so a bake can hide the live mascot
    G.add("bot_body", m["body_v"], m["body_f"], [True] * len(m["body_f"]))
    G.add("eye", m["eye_v"], m["eye_f"], [True] * len(m["eye_f"]))


# ---------- one bot, one world ----------
def bot_mats(key, col, state):
    m_ = max(col)
    c_ = tuple((x / m_) ** 1.7 for x in col)
    hot = tuple(x * 0.88 + 0.12 for x in c_)
    k = dict(idle=0.5, working=1.0, found=1.55, done=0.85, main=0.7)[state]
    if state == "main":
        c_ = (1.0, 0.7, 0.4)
        hot = (1.0, 0.8, 0.55)
    names = dict(led_on=f"led_on_{key}", led_dim=f"led_dim_{key}", led_hot=f"led_hot_{key}", bot=f"bot_{key}")
    MATS[names["led_on"]] = pbsdf(names["led_on"], (0, 0, 0), 0.4, emis=c_, emis_str=3.1 * k)
    MATS[names["led_dim"]] = pbsdf(names["led_dim"], (0, 0, 0), 0.4, emis=c_, emis_str=1.2 * k)
    MATS[names["led_hot"]] = pbsdf(names["led_hot"], (0, 0, 0), 0.4, emis=hot, emis_str=5.5 * k)
    MATS[names["bot"]] = pbsdf(names["bot"], col, 0.42, coat=mascots.GLOSSY["coat"], coat_rough=0.03, sss=mascots.GLOSSY["sss"], sss_scale=mascots.GLOSSY["sss_scale"] * 0.82)
    names["bot_body"] = f"bot_body_{key}"
    MATS[names["bot_body"]] = MATS[names["bot"]]
    if state == "main":
        names["led_off"] = names["led_dim"]
        names["tower"] = "main_frame"
        names["tower2"] = "main_trim"
        names["seam"] = "main_trim"
    return names, c_


# ---------- the survey: three bots, one frozen river, one line of work ----------
# Work runs upstream. Orange drills on the ice and lines up cores. Pink tows a sled of them upriver.
# The white lead stacks them into the data vault on the bluff at the head, and the vault visibly fills up.
C_CAM = Vector((-5.0, -42.0, 21.0))
C_TG = Vector((0.6, 1.2, 3.72))
LENS = 44.0
FOCUS = 49.0
LAY = dict(cam=C_CAM, target=C_TG, lens=LENS, focus=FOCUS, scale=1.0)
CAMXY = (C_CAM.x, C_CAM.y)

RIVER_CP = [(-20.0, -26.0), (-13.0, -19.0), (-4.5, -11.6), (5.0, -7.4), (3.2, -2.2), (-5.0, 1.6), (-6.2, 5.6), (-1.6, 8.6), (3.4, 9.6)]
RIVER_W = [3.4, 3.4, 3.4, 3.9, 3.0, 3.5, 3.1, 2.5, 2.3]
DRILL = (5.3, -6.5)
BLUFF = (9.8, 14.0)
BLUFF_S, BLUFF_SZ = 2.2, 2.75
VAULT_SC = 1.1
VAULT_O = (9.1, 12.8)
VAULT_YAW = -0.66


def smooth(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


def _catmull(P, n):
    out = []
    P2 = [P[0]] + list(P) + [P[-1]]
    for i in range(1, len(P2) - 2):
        p0, p1, p2, p3 = (np.array(P2[i - 1], float), np.array(P2[i], float), np.array(P2[i + 1], float), np.array(P2[i + 2], float))
        for t in np.linspace(0, 1, n, endpoint=False):
            out.append(0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (3 * p1 - p0 - 3 * p2 + p3) * t ** 3))
    out.append(np.array(P[-1], float))
    return np.array(out)


RIV = _catmull(RIVER_CP, 24)
RIV_WD = np.interp(np.linspace(0, len(RIVER_CP) - 1, len(RIV)), range(len(RIVER_CP)), RIVER_W)
GX = np.linspace(-66, 66, 800)
GY = np.linspace(-46, 86, 800)
_XX, _YY = np.meshgrid(GX, GY)
D_GRID = np.full(_XX.shape, 1e9, np.float32)
for _q, _w in zip(RIV, RIV_WD):
    D_GRID = np.minimum(D_GRID, np.hypot(_XX - _q[0], _YY - _q[1]).astype(np.float32) - float(_w))


# Sleds run on two lanes the whole way, a convoy up and the empties back, so they never have to wait for each other.
def _lane(offsets, i0=92, i1=170, step=2):
    xs, ys = zip(*offsets)
    idx = np.arange(0, len(RIV))
    raw = np.interp(idx, xs, ys)
    ker = np.exp(-np.linspace(-2, 2, 15) ** 2)
    ker /= ker.sum()
    smoothed = np.convolve(np.pad(raw, 7, mode="edge"), ker, mode="valid")
    out = []
    for i in range(i0, i1 + 1, step):
        d_ = RIV[min(i + 2, len(RIV) - 1)] - RIV[i - 2]
        d_ = d_ / (np.linalg.norm(d_) + 1e-9)
        out.append(RIV[i] + np.array((-d_[1], d_[0])) * float(smoothed[i]))
    return np.array(out)


LANE_UP = _lane([(0, 0.6), (112, 0.6), (126, -0.4), (138, -0.4), (152, 0.3), (193, 0.3)], i0=76, i1=172)
LANE_DOWN = _lane([(0, -1.3), (112, -1.3), (126, -1.95), (138, -1.95), (152, -1.3), (193, -1.3)])
_ti = 132
_td = RIV[_ti + 3] - RIV[_ti - 3]
_td = _td / np.linalg.norm(_td)
_tn = np.array((-_td[1], _td[0]))
# the bot stands on the outside of the bend, the capstan beside it towards the lane
TOW_CAP = RIV[_ti] + _tn * 0.95
TOW = RIV[_ti] + _tn * 2.15
TOW_YAW = math.atan2(-_tn[1], -_tn[0])


def riv_d(x, y):
    i = int(np.clip((x - GX[0]) / (GX[1] - GX[0]), 0, len(GX) - 1))
    j = int(np.clip((y - GY[0]) / (GY[1] - GY[0]), 0, len(GY) - 1))
    return float(D_GRID[j, i])


def terrain_at(x, y, d0):
    n1 = noise.fractal(Vector((x * 0.5, y * 0.5, 3.0)), 1.0, 2.0, 4)
    d = d0 + 0.55 * n1
    n2 = noise.fractal(Vector((x * 1.6, y * 1.6, 2.0)), 1.0, 2.0, 4)
    n3 = noise.fractal(Vector((x * 0.14, y * 0.14, 7.0)), 1.0, 2.0, 4)
    lip = smooth(d / 1.1)
    z = -0.14 + lip * (0.62 + 0.16 * n2)
    w = max(d - 1.1, 0.0)
    z += 0.1 * w + 0.0065 * w * w
    bd = math.hypot(x - BLUFF[0], y - BLUFF[1])
    z += smooth((y - 4.0) / 24.0) * 4.5 * smooth(d / 7.0) * (0.18 + 0.82 * smooth((bd - 8.0) / 11.0))
    z += 0.95 * n3 * smooth(d / 5.0)
    # wind-cut drifts, so the banks have shape under a low sun
    rd = noise.ridged_multi_fractal(Vector((x * 0.42 + y * 0.16, y * 0.5 - x * 0.1, 3.0)), 1.0, 2.1, 4, 1.0, 2.0)
    z += 0.3 * (rd - 0.75) * smooth(d / 2.5)
    if -1.6 < d < 0.2:
        p = noise.fractal(Vector((x * 0.7, y * 0.7, 9.0)), 1.0, 2.0, 4)
        z = max(z, (p - 0.66) * 0.5 * smooth((d + 1.6) / 1.6))
    if d0 > 0.0:
        z = -0.14 + (z + 0.14) * (0.32 + 0.68 * smooth((y + 11.0) / 5.0))
        # This bank rose into a ridge close to the lens, and the blur made one pale mound of it. Keep it low.
        z = -0.14 + (z + 0.14) * (1.0 - 0.78 * smooth((x - 7.0) / 7.0) * (1.0 - smooth((y + 4.0) / 9.0)))
        # Low, but never under the ice plane, or a stray pool shows through far from the river.
        if d0 > 2.0:
            z = max(z, 0.1)
    return z


def ground_z(x, y):
    return terrain_at(x, y, riv_d(x, y))


def build_ground():
    V = np.array([(-200, -200, 0), (200, -200, 0), (200, 200, 0), (-200, 200, 0)], float)
    mesh_obj("ice", V, [(0, 1, 2, 3)], "ice", smooth=False)
    V = [(float(GX[i]), float(GY[j]), terrain_at(float(GX[i]), float(GY[j]), float(D_GRID[j, i]))) for j in range(len(GY)) for i in range(len(GX))]
    NX = len(GX)
    F = [(j * NX + i, j * NX + i + 1, (j + 1) * NX + i + 1, (j + 1) * NX + i) for j in range(len(GY) - 1) for i in range(NX - 1)]
    mesh_obj("banks", np.array(V), F, "snow_bank")


build_ground()
print("ground built", flush=True)


def point(p, e, col=(1.0, 0.62, 0.3), r=0.03):
    l = bpy.data.lights.new("pt", "POINT")
    l.energy = e
    l.color = col
    l.shadow_soft_size = r
    o = bpy.data.objects.new("pt", l)
    o.location = p
    bpy.context.collection.objects.link(o)


def tube(mat, pts, r, seg=6):
    last = None
    for p_ in pts:
        if last is not None:
            cyl(mat, last, p_, r, seg=seg, cap=False)
            sphere(mat, p_, r, seg=seg, rings=4)
        last = p_


def lattice(x, y, z0, h, base=0.17, top=0.045, n=11, mat="rail"):
    legs = [(math.cos(a), math.sin(a)) for a in (0.5, 2.6, 4.7)]
    rings_ = []
    for i in range(n + 1):
        t = i / n
        r_ = base + (top - base) * t
        rings_.append([(x + r_ * lx_, y + r_ * ly_, z0 + h * t) for lx_, ly_ in legs])
    for k in range(3):
        for i in range(n):
            cyl(mat, rings_[i][k], rings_[i + 1][k], 0.016 - 0.006 * i / n, seg=6, cap=False)
            cyl(mat, rings_[i][k], rings_[i + 1][(k + 1) % 3], 0.006, seg=4, cap=False)
            cyl(mat, rings_[i + 1][k], rings_[i + 1][(k + 1) % 3], 0.006, seg=4, cap=False)


def ribbon(mat, pts, width=0.05, closed=False):
    pts = np.array(pts, float)
    d = np.roll(pts, -1, axis=0) - np.roll(pts, 1, axis=0)
    if not closed:
        d[0], d[-1] = pts[1] - pts[0], pts[-1] - pts[-2]
    n_ = np.stack((-d[:, 1], d[:, 0], np.zeros(len(d))), axis=1)
    n_ /= np.linalg.norm(n_, axis=1, keepdims=True) + 1e-9
    V = np.concatenate((pts + n_ * width / 2, pts - n_ * width / 2))
    N = len(pts)
    F = [(i, (i + 1) % N, N + (i + 1) % N, N + i) for i in range(N if closed else N - 1)]
    G.add(mat, V, F, [False] * len(F))


def core(a, b, r=0.11):
    """One ice core: pale ice with thin dark layers, lit at both ends. The same amber as the vault's full cells."""
    a, b = np.array(a, float), np.array(b, float)
    cuts = [0.0, 0.2, 0.235, 0.46, 0.51, 0.7, 0.725, 1.0]
    mats = ("core_a", "core_b", "core_a", "core_c", "core_a", "core_b", "core_a")
    for i, m_ in enumerate(mats):
        cyl(m_, a + (b - a) * cuts[i], a + (b - a) * cuts[i + 1], r, seg=18, cap=False)
    v = (b - a) / (np.linalg.norm(b - a) + 1e-9)
    for e_, sg in ((a, -1), (b, 1)):
        cyl("cell_a", e_ - v * 0.006, e_ + v * 0.012 * sg, r * 0.8, seg=18)
        lathe_axis = e_ + v * 0.002 * sg
        cyl("main_trim", lathe_axis - v * 0.018 * sg, lathe_axis + v * 0.004 * sg, r * 1.02, seg=18, cap=False)


def core_unit():
    """One core, length 1 along y, centred on the origin. Every live core is a copy of this one."""
    r_ = 0.075
    a, b = np.array((0.0, -0.5, 0.0)), np.array((0.0, 0.5, 0.0))
    cyl("core_a", a, b, r_, seg=16)
    for c0, c1, m_ in ((0.2, 0.235, "core_b"), (0.46, 0.51, "core_c"), (0.7, 0.725, "core_b")):
        cyl(m_, a + (b - a) * c0, a + (b - a) * c1, r_ * 1.012, seg=16, cap=False)
    for e_, sg in ((a, 1), (b, -1)):
        cyl("main_trim", e_ + np.array((0.0, sg * 0.004, 0.0)), e_ + np.array((0.0, sg * 0.016, 0.0)), r_ * 1.03, seg=16, cap=False)


def tray(cx, cy, cz, n_slots=6, filled=6, L=1.8, pitch=0.36):
    """A long field box of cores, side by side, the axis along x."""
    D = n_slots * pitch + 0.1
    box("timber", (cx, cy, cz + 0.05), (L + 0.2, D, 0.1), r=0.012)
    for s_ in (-1, 1):
        box("timber2", (cx + s_ * (L / 2 + 0.11), cy, cz + 0.11), (0.05, D, 0.2), r=0.008)
        box("timber2", (cx, cy + s_ * (D / 2), cz + 0.11), (L + 0.26, 0.05, 0.2), r=0.008)
    for k in range(n_slots):
        y = cy - D / 2 + 0.05 + pitch * (k + 0.5)
        if PT.ON:
            # the box goes in the plate with its rubber beds empty. The cores are live.
            box("rubber", (cx, y, cz + 0.105), (L - 0.06, pitch * 0.66, 0.01), r=0.0)
            PT.spot("tray", st_world((cx, y, cz + 0.22)), scale=(L - 0.06) * CUR_ST["sc"], yaw=CUR_ST["yaw"] + math.pi / 2)
        elif k < filled:
            core((cx - L / 2 + 0.03, y, cz + 0.22), (cx + L / 2 - 0.03, y, cz + 0.22), r=0.13)
        else:
            box("rubber", (cx, y, cz + 0.105), (L - 0.06, pitch * 0.66, 0.01), r=0.0)
    for x_ in (-0.5, 0.5):
        box("rail", (cx + x_ * L * 0.75, cy, cz + 0.205), (0.05, D + 0.02, 0.012), r=0.0)
    box("rubber", (cx, cy - D / 2 - 0.03, cz + 0.05), (L + 0.34, 0.06, 0.04), r=0.01)


def drill_site():
    """The rig over the hole. Everything here serves one job: bring a core up and line it up."""
    lathe("plinth", (0, 0, 0), [(1.55, 0.0), (1.55, 0.05), (1.5, 0.07), (0.38, 0.07), (0.36, 0.02), (0.001, 0.02)], seg=72)
    lathe("led_on", (0, 0, 0.072), [(1.2, 0.0), (1.28, 0.0)], seg=72)
    for a in np.linspace(0, 6.28, 20, endpoint=False):
        sphere("lamp", (1.4 * math.cos(a), 1.4 * math.sin(a), 0.085), 0.016, seg=8, rings=5)
    H = 4.2
    feet = [(1.22 * math.cos(a), 1.22 * math.sin(a), 0.07) for a in (1.57, 3.67, 5.76)]
    apex = np.array((0, 0, H))
    for f in feet:
        cyl("steel", f, apex, 0.07, seg=12, r2=0.04)
        box("tower2", f, (0.2, 0.2, 0.06), r=0.012)
    for lv in (0.2, 0.42, 0.62, 0.8):
        q = [np.array(f) + (apex - np.array(f)) * lv for f in feet]
        for i in range(3):
            cyl("rail", q[i], q[(i + 1) % 3], 0.02, seg=6, cap=False)
    for lv0, lv1 in ((0.2, 0.42), (0.42, 0.62)):
        for i in range(3):
            a0 = np.array(feet[i]) + (apex - np.array(feet[i])) * lv0
            a1 = np.array(feet[(i + 1) % 3]) + (apex - np.array(feet[(i + 1) % 3])) * lv1
            cyl("rail", a0, a1, 0.014, seg=5, cap=False)
    box("tower2", (0, 0, H + 0.05), (0.42, 0.42, 0.18), r=0.03)
    cyl("steel", (-0.15, 0, H + 0.14), (0.15, 0, H + 0.14), 0.09, seg=14)
    pillow((0, 0, H + 0.2), 0.38, 0.38, 0.07, n=8)
    sphere("beacon", (0, 0, H + 0.34), 0.035, seg=10, rings=6)
    # The string is the part that turns and comes down. A plain rod would not show it turning, so it carries auger flights.
    # Built at the bottom of the stroke, in the hole: it only ever lifts from here and comes back.
    with PT.actor("drill_string", pivot=st_world((0, 0, 0))):
        cyl("steel", (0, 0, 0.02), (0, 0, H - 1.15), 0.065, seg=14)
        for z_ in (0.42, 1.62, 2.42, 2.96):
            cyl("tower2", (0, 0, z_ - 0.05), (0, 0, z_ + 0.05), 0.085, seg=14)
        for z0_, z1_ in ((0.1, 0.72), (1.55, 2.9)):
            n_f = int((z1_ - z0_) / 0.012)
            Vf, Ff = [], []
            for i_ in range(n_f):
                a_ = i_ * 0.13
                z_ = z0_ + (z1_ - z0_) * i_ / (n_f - 1)
                Vf += [(0.06 * math.cos(a_), 0.06 * math.sin(a_), z_), (0.21 * math.cos(a_), 0.21 * math.sin(a_), z_ + 0.012)]
            Ff = [(2 * k_, 2 * k_ + 1, 2 * k_ + 3, 2 * k_ + 2) for k_ in range(n_f - 1)]
            G.add("steel", np.array(Vf), Ff, [True] * len(Ff))
    # the drill head on the string, in the bot's colour
    with PT.actor("drill_head", pivot=st_world((0, 0, 0.98))):
        box("bot", (0, 0, 0.98), (0.72, 0.54, 0.5), r=0.07, seg=3)
        box("main_trim", (0, -0.28, 0.98), (0.5, 0.02, 0.2), r=0.004)
        box("led_on", (0, -0.295, 0.98), (0.4, 0.008, 0.06), r=0.0)
        cyl("steel", (0, 0, 1.23), (0, 0, 1.46), 0.14, seg=16)
        pillow((0, 0, 1.23), 0.66, 0.5, 0.04, n=8)
    with PT.drop():
        cyl("rail", (0.3, 0, 1.6), (1.15, 0.55, 0.35), 0.016, seg=6)
    PT.spot("hole", st_world((0, 0, 0.1)))
    # winch and its cable to the crown
    box("crate2", (1.55, 1.1, 0.24), (1.05, 0.7, 0.34), r=0.03)
    with PT.actor("winch_drum", pivot=st_world((1.55, 1.1, 0.56))):
        cyl("bot", (1.2, 1.1, 0.56), (1.9, 1.1, 0.56), 0.2, seg=20)
        for a_ in np.linspace(0, 6.28, 6, endpoint=False):
            box("steel", (1.55, 1.1 + 0.205 * math.cos(a_), 0.56 + 0.205 * math.sin(a_)), (0.72, 0.035, 0.035), r=0.0, rx=float(a_))
    PT.spot("winch_axis", st_world((2.55, 1.1, 0.56)))
    cyl("rail", (1.25, 1.1, 0.74), (0, 0, H + 0.05), 0.008, seg=5, cap=False)
    pillow((1.55, 1.1, 0.74), 0.62, 0.34, 0.03, n=7)
    # power skid with an exhaust
    box("crate", (-1.75, 1.05, 0.28), (1.1, 0.68, 0.5), r=0.03)
    for i in range(10):
        box("rail", (-2.2 + i * 0.1, 0.705, 0.28), (0.018, 0.012, 0.36), r=0.0)
    cyl("steel", (-1.35, 1.2, 0.5), (-1.35, 1.2, 1.15), 0.04, seg=10)
    pillow((-1.75, 1.05, 0.53), 0.98, 0.6, 0.06, n=9)
    sphere("lamp", (-1.2, 0.7, 0.44), 0.016, seg=8, rings=5)
    # work light
    cyl("rail", (-1.5, -0.2, 0.07), (-1.5, -0.2, 2.35), 0.02, seg=7)
    box("rail", (-1.46, -0.25, 2.35), (0.24, 0.05, 0.16), r=0.012, rx=0.5)
    box("lamp", (-1.46, -0.285, 2.33), (0.2, 0.006, 0.12), r=0.0, rx=0.5)
    point((-0.9, -1.0, 1.6), 5.5, col=(1.0, 0.68, 0.38), r=0.2)
    # a fresh core on its cradle, between the hole and the boxes
    for x_ in (-0.95, 0.1):
        box("timber2", (x_, -1.8, 0.14), (0.12, 0.36, 0.26), r=0.012)
    with PT.drop():
        core((-1.25, -1.8, 0.36), (0.4, -1.8, 0.36), r=0.14)
    PT.spot("cradle", st_world((-0.425, -1.8, 0.36)), scale=1.65 * CUR_ST["sc"], yaw=CUR_ST["yaw"] + math.pi / 2)
    # the line of boxes: two full, one still filling
    tray(-1.05, -3.3, 0.0, 6, 3)
    tray(-3.5, -3.2, 0.0, 6, 6)
    tray(-3.3, -0.9, 0.0, 6, 6)
    # the lever the bot hops on: it works the drill brake
    with PT.actor("lever", pivot=st_world((1.05, -0.82, 0.52))):
        cyl("steel", (0.5, -0.62, 0.72), (2.25, -1.25, 0.2), 0.032, seg=10)
    PT.spot("lever_axis", st_world((1.05 + 0.339, -0.82 + 0.94, 0.52)))
    box("tower2", (1.05, -0.82, 0.27), (0.22, 0.22, 0.36), r=0.02)
    cyl("tower2", (0.98, -0.82, 0.52), (1.14, -0.82, 0.52), 0.06, seg=12)
    lathe("tower2", (2.45, -1.32, 0.0), [(0.6, 0.0), (0.6, 0.14), (0.57, 0.17), (0.001, 0.17)], seg=44)
    lathe("led_dim", (2.45, -1.32, 0.171), [(0.44, 0.0), (0.49, 0.0)], seg=44)
    # survey stakes: the holes already done, flagged in a line downriver
    fw = bot_world_dir(C_CAM, DRILL, DRILL_YAW)
    bot((2.45, -1.32, 0.17 + 1.3 * 0.47), 1.3, "squircle", facing=math.atan2(fw[0] * 0.9 - 0.3, -fw[1]), tool="wrench", scale=1.3, lift=0.12)


def stakes():
    """The survey line: finished holes capped and flagged along the river below the rig."""
    for k, t_ in enumerate((62, 55)):
        q = RIV[t_]
        c_ = RIV[t_] + np.array((-0.6 + 0.9 * (k % 2), 0.2 * k))
        lathe("plinth", (c_[0], c_[1], 0.0), [(0.34, 0.0), (0.34, 0.03), (0.3, 0.05), (0.001, 0.05)], seg=24)
        lathe("led_dim", (c_[0], c_[1], 0.051), [(0.17, 0.0), (0.21, 0.0)], seg=24)
        cyl("rail", (c_[0] + 0.2, c_[1] + 0.12, 0.0), (c_[0] + 0.2, c_[1] + 0.12, 1.0), 0.012, seg=6)
        V_ = np.array([(0, 0, 1.0), (0.3, 0, 0.92), (0, 0, 0.8)]) + np.array((c_[0] + 0.2, c_[1] + 0.12, 0.0))
        # lit, so the flag takes whatever colour the bot has
        G.add("led_dim", V_, [(0, 1, 2)], [False])


SLED_CORES = ((-0.35, 0.46), (0.0, 0.46), (0.35, 0.46), (-0.175, 0.74), (0.175, 0.74))


def sled_body():
    """Local +y is the way it travels: runners, deck and lantern. The load is separate because it comes and goes."""
    L, W_ = 2.7, 1.14
    for sx in (-1, 1):
        x = sx * W_ / 2
        pts = [(x, -L / 2, 0.035), (x, L / 2 - 0.5, 0.035), (x, L / 2 - 0.25, 0.08), (x, L / 2 - 0.06, 0.2), (x, L / 2 + 0.02, 0.36)]
        tube("steel", pts, 0.032, seg=8)
        for y in (-L / 2 + 0.3, -0.25, L / 2 - 0.75):
            cyl("rail", (x, y, 0.04), (x, y, 0.27), 0.016, seg=6)
    box("timber", (0, -0.15, 0.29), (W_ + 0.12, L - 0.7, 0.05), r=0.012)
    for y in np.linspace(-L / 2 + 0.25, L / 2 - 0.65, 8):
        box("timber2", (0, float(y), 0.318), (W_ + 0.12, 0.018, 0.006), r=0.0)
    cyl("steel", (-W_ / 2, L / 2 + 0.02, 0.36), (W_ / 2, L / 2 + 0.02, 0.36), 0.024, seg=8)
    box("timber2", (0, -L / 2 + 0.1, 0.6), (W_, 0.05, 0.6), r=0.01)
    cyl("rail", (0.5, -L / 2 + 0.1, 0.3), (0.5, -L / 2 + 0.1, 1.3), 0.012, seg=6)
    sphere("lamp", (0.5, -L / 2 + 0.1, 1.33), 0.03, seg=10, rings=6)
    cyl("rail", (-W_ / 2, L / 2 + 0.02, 0.36), (0, L / 2 + 0.6, 0.47), 0.01, seg=5, cap=False)
    cyl("rail", (W_ / 2, L / 2 + 0.02, 0.36), (0, L / 2 + 0.6, 0.47), 0.01, seg=5, cap=False)


def sled_straps():
    for y in (-0.75, 0.15):
        box("rubber", (0, y, 0.92), (0.62, 0.05, 0.016), r=0.0)
        for s_ in (-1, 1):
            box("rubber", (s_ * 0.5, y, 0.63), (0.016, 0.05, 0.62), r=0.0)


def tow_post():
    """The hauling post on the bend. The bot leans on the capstan and the sled comes up the line."""
    cx = float(np.linalg.norm(TOW_CAP - TOW))
    lathe("plinth", (0, 0, 0), [(0.98, 0.0), (0.98, 0.05), (0.94, 0.07), (0.001, 0.07)], seg=60)
    lathe("led_on", (0, 0, 0.072), [(0.8, 0.0), (0.87, 0.0)], seg=60)
    lathe("plinth", (cx, 0, 0), [(0.6, 0.0), (0.6, 0.05), (0.56, 0.07), (0.001, 0.07)], seg=48)
    lathe("led_dim", (cx, 0, 0.072), [(0.46, 0.0), (0.5, 0.0)], seg=48)
    # two ice anchors hold the post against the pull
    for a_, r_ in ((2.3, 1.45), (-2.2, 1.45)):
        x_, y_ = r_ * math.cos(a_), r_ * math.sin(a_)
        cyl("rail", (x_, y_, 0.0), (x_, y_, 0.42), 0.022, seg=7)
        cyl("rail", (x_, y_, 0.36), (cx * 0.5, 0.0, 0.16), 0.009, seg=5, cap=False)
    with PT.actor("capstan", pivot=st_world((cx, 0, 0.07))):
        lathe("steel", (cx, 0, 0.07), [(0.001, 0.0), (0.3, 0.0), (0.3, 0.05), (0.19, 0.1), (0.17, 0.42), (0.22, 0.47), (0.22, 0.53), (0.001, 0.56)], seg=28)
        for a_ in np.linspace(0, 6.28, 8, endpoint=False):
            cyl("tower2", (cx + 0.18 * math.cos(a_), 0.18 * math.sin(a_), 0.2), (cx + 0.18 * math.cos(a_), 0.18 * math.sin(a_), 0.47), 0.018, seg=6)
        for a_ in np.linspace(0, 6.28, 4, endpoint=False):
            tip = (cx + 0.46 * math.cos(a_), 0.46 * math.sin(a_), 0.56)
            cyl("steel", (cx, 0, 0.57), tip, 0.024, seg=8)
            sphere("bot", tip, 0.05, seg=12, rings=8)
    PT.spot("capstan_rope", st_world((cx, 0, 0.45)))
    bs_ = 1.54
    fw = bot_world_dir(C_CAM, tuple(TOW), TOW_YAW)
    bot((0, 0, 0.07 + bs_ * 0.47), bs_, "cloud", facing=math.atan2(fw[0] * 0.86 + 0.26, -fw[1] * 0.86))


def sled():
    """Local +y is the way it travels. The sled is here, the bot leads it on a rope."""
    L, W_ = 2.7, 1.14
    for sx in (-1, 1):
        x = sx * W_ / 2
        pts = [(x, -L / 2, 0.035), (x, L / 2 - 0.5, 0.035), (x, L / 2 - 0.25, 0.08), (x, L / 2 - 0.06, 0.2), (x, L / 2 + 0.02, 0.36)]
        tube("steel", pts, 0.032, seg=8)
        for y in (-L / 2 + 0.3, -0.25, L / 2 - 0.75):
            cyl("rail", (x, y, 0.04), (x, y, 0.27), 0.016, seg=6)
    box("timber", (0, -0.15, 0.29), (W_ + 0.12, L - 0.7, 0.05), r=0.012)
    for y in np.linspace(-L / 2 + 0.25, L / 2 - 0.65, 8):
        box("timber2", (0, float(y), 0.318), (W_ + 0.12, 0.018, 0.006), r=0.0)
    cyl("steel", (-W_ / 2, L / 2 + 0.02, 0.36), (W_ / 2, L / 2 + 0.02, 0.36), 0.024, seg=8)
    # the load: cores along the sled, three below and two on top, strapped down
    for x_, z_ in ((-0.35, 0.46), (0.0, 0.46), (0.35, 0.46), (-0.175, 0.74), (0.175, 0.74)):
        core((x_, L / 2 - 0.75, z_), (x_, -L / 2 + 0.2, z_), r=0.15)
    for y in (-0.75, 0.15):
        box("rubber", (0, y, 0.92), (0.62, 0.05, 0.016), r=0.0)
        for s_ in (-1, 1):
            box("rubber", (s_ * 0.5, y, 0.63), (0.016, 0.05, 0.62), r=0.0)
    box("timber2", (0, -L / 2 + 0.1, 0.6), (W_, 0.05, 0.6), r=0.01)
    # lantern on the back
    cyl("rail", (0.5, -L / 2 + 0.1, 0.3), (0.5, -L / 2 + 0.1, 1.3), 0.012, seg=6)
    sphere("lamp", (0.5, -L / 2 + 0.1, 1.33), 0.03, seg=10, rings=6)
    point((0.5, -L / 2 + 0.1, 1.3), 1.2, col=(1.0, 0.62, 0.3), r=0.04)
    # the rope and the bot leaning into it
    by, bs_ = L / 2 + 1.7, 1.28
    cyl("rail", (0, L / 2 + 0.02, 0.36), (0.0, by - 0.42, 0.62), 0.016, seg=6, cap=False)
    cyl("rail", (-W_ / 2, L / 2 + 0.02, 0.36), (0, L / 2 + 0.6, 0.47), 0.01, seg=5, cap=False)
    cyl("rail", (W_ / 2, L / 2 + 0.02, 0.36), (0, L / 2 + 0.6, 0.47), 0.01, seg=5, cap=False)
    fw = bot_world_dir(C_CAM, SLED_XY, SLED_YAW)
    mix_x, mix_y = fw[0] * 0.75, fw[1] * 0.75 + 0.55
    bot((0, by, bs_ * 0.47), bs_, "cloud", facing=math.atan2(mix_x, -mix_y))
    # the shuffle track in the snow dust: small push marks under the bot
    for k in range(5):
        sphere("dent", (0.09 * (-1) ** k, by - 0.5 - k * 0.14, 0.004), 0.1, seg=12, rings=5, sc=(1.0, 0.8, 0.04))


def vault_b():
    """Local -y is the honeycomb face. Lit cells hold a core. Dark cells are still to fill."""
    W, D, H, ZB = 7.2, 4.2, 5.2, 0.24
    FACE_W = 6.0
    box("concrete", (0, 1.0, 0.12), (8.6, 8.0, 0.24), r=0.04)
    # snow lies deep on the deck edges, the dock itself is swept
    N = 130
    xs, ys = np.linspace(-4.8, 4.8, N), np.linspace(-3.5, 5.4, N)
    Vd = []
    for y in ys:
        for x in xs:
            wob = 0.22 * noise.fractal(Vector((x * 0.9, y * 0.9, 11.0)), 1.0, 2.0, 4)
            ed = min(x + 4.3, 4.3 - x, y + 3.0, 5.0 - y) + wob
            na = noise.fractal(Vector((x * 1.5, y * 1.5, 4.0)), 1.0, 2.0, 5)
            h = -0.04 + 0.34 * max(0.0, 1.0 - max(ed, 0.0) / 0.8) + 0.05 * na
            if ed < 0.0:
                h += ed * 0.9
            Vd.append((float(x), float(y), ZB + h))
    Fd = [(j * N + i, j * N + i + 1, (j + 1) * N + i + 1, (j + 1) * N + i) for j in range(N - 1) for i in range(N - 1)]
    mesh_obj("deck_snow", np.array(Vd), Fd, "snow")
    # the body catches the sun
    box("main_trim", (0, D / 2, ZB + 0.2), (W + 0.34, D + 0.34, 0.4), r=0.02)
    box("main_frame", (0, D / 2, ZB + H / 2), (W, D, H), r=0.04, seg=2)
    # a stepped crown behind the face, with warm slits
    box("main_frame", (0.2, D * 0.62, ZB + H + 0.55), (W - 2.4, D - 1.5, 1.1), r=0.03, seg=2)
    box("main_trim", (0.2, D * 0.62, ZB + H + 1.12), (W - 2.2, D - 1.3, 0.09), r=0.015)
    pillow((0.2, D * 0.62, ZB + H + 1.16), W - 2.25, D - 1.35, 0.2, n=20)
    for x_ in np.linspace(-1.9, 2.3, 11):
        box("win_warm", (float(x_), D * 0.62 - (D - 1.5) / 2 - 0.006, ZB + H + 0.62), (0.075, 0.008, 0.46), r=0.0)
    icicles((-2.2, D * 0.62 - (D - 1.5) / 2 - 0.06, ZB + H + 1.08), (2.6, D * 0.62 - (D - 1.5) / 2 - 0.06, ZB + H + 1.08), 28, 0.14)
    # sloped buttresses at both corners of the face: the vault leans into the bluff
    for x_ in (-W / 2, W / 2):
        Bw = 0.46
        V_ = np.array([(-Bw, -1.05, 0), (Bw, -1.05, 0), (Bw, 0.15, 0), (-Bw, 0.15, 0), (-Bw * 0.62, -0.28, H + 0.1), (Bw * 0.62, -0.28, H + 0.1), (Bw * 0.62, 0.15, H + 0.1), (-Bw * 0.62, 0.15, H + 0.1)]) + np.array((x_, 0.0, ZB))
        G.add("main_frame", V_, [(0, 1, 5, 4), (1, 2, 6, 5), (3, 0, 4, 7), (4, 5, 6, 7), (2, 3, 7, 6)], [False] * 5)
        box("main_trim", (x_, -0.55, ZB + 0.2), (Bw * 2 + 0.16, 1.1, 0.4), r=0.02)
        # snow lying on the slope
        n_v = np.array((0, -(H + 0.1), 0.77)) / math.hypot(H + 0.1, 0.77)
        ang_ = math.atan2(0.77, H + 0.1)
        for t_ in (0.2, 0.42, 0.64, 0.86):
            box("main_trim", (x_, -1.05 + 0.77 * t_ - 0.004, ZB + (H + 0.1) * t_), (Bw * (2 - 0.76 * t_) + 0.02, 0.05, 0.04), r=0.004)
            pillow((x_, -1.05 + 0.77 * t_ - 0.02, ZB + (H + 0.1) * t_ + 0.016), Bw * (2 - 0.76 * t_), 0.09, 0.03, n=6)
        pillow((x_, -0.06, ZB + H + 0.1), Bw * 1.24 + 0.03, 0.47, 0.09, n=8)
    # Standing seams and cool edge lights. The ribs catch the low sun, which is what makes this read as sheet steel.
    for x_ in np.arange(-W / 2 + 0.11, -FACE_W / 2 - 0.02, 0.11):
        box("main_trim", (float(x_), -0.012, ZB + H / 2), (0.022, 0.03, H - 0.1), r=0.0)
    for x_ in np.arange(FACE_W / 2 + 0.06, W / 2 - 0.02, 0.11):
        box("main_trim", (float(x_), -0.012, ZB + H / 2), (0.022, 0.03, H - 0.1), r=0.0)
    for x_ in np.arange(-(W - 2.4) / 2 + 0.2, (W - 2.4) / 2 + 0.2, 0.2):
        box("main_trim", (float(x_), D * 0.62 - (D - 1.5) / 2 - 0.002, ZB + H + 0.16), (0.03, 0.02, 0.26), r=0.0)
    for x_ in (-W / 2, W / 2):
        for s_ in (-1, 1):
            V_ = np.array([(s_ * 0.47, -1.06, 0.42), (s_ * 0.3, -0.29, H + 0.08)]) + np.array((x_, 0.0, ZB))
            cyl("edge_ice", V_[0], V_[1], 0.016, seg=6)
        for x2_ in np.arange(-0.34, 0.36, 0.085):
            V_ = np.array([(x2_, -1.07, 0.42), (x2_ * 0.62, -0.3, H + 0.08)]) + np.array((x_, 0.0, ZB))
            cyl("main_trim", V_[0], V_[1], 0.011, seg=5, cap=False)
    box("edge_ice", (0, -0.34, ZB + H - 0.08), (W + 0.5, 0.012, 0.022), r=0.0)
    # a warm strip over the honeycomb
    box("main_trim", (0, -0.1, ZB + 0.62 + 4.0 + 0.2), (6.3, 0.22, 0.1), r=0.012)
    box("cell_b", (0, -0.2, ZB + 0.62 + 4.0 + 0.145), (5.9, 0.03, 0.012), r=0.0)
    pillow((0, -0.1, ZB + 0.62 + 4.0 + 0.25), 6.25, 0.22, 0.05, n=14)
    # the sill below it, with a chain of small stations
    box("main_trim", (0, -0.12, ZB + 0.52), (6.3, 0.26, 0.12), r=0.012)
    # the honeycomb
    FW, FH = 6.0, 4.0
    FZ = ZB + 0.62
    box("main_trim", (0, -0.015, FZ + FH / 2), (FW + 0.1, 0.03, FH + 0.1), r=0.0)
    R_ = 0.385
    px_ = R_ * math.sqrt(3.0)
    py_ = R_ * 1.5
    rows = 6
    fill = [9, 8, 9, 8, 5, 0]    # the frontier: the fifth row is part way across
    hot_seed = 3.0
    FRONT = None
    ang6 = [math.pi / 2 + k_ * math.pi / 3 for k_ in range(6)]

    def hexring(cx, cz, R0, R1, y0, y1, mat):
        V_ = [(cx + R0 * math.cos(t_), y0, cz + R0 * math.sin(t_)) for t_ in ang6] + [(cx + R1 * math.cos(t_), y1, cz + R1 * math.sin(t_)) for t_ in ang6]
        F_ = [(k_, (k_ + 1) % 6, 6 + (k_ + 1) % 6, 6 + k_) for k_ in range(6)]
        G.add(mat, np.array(V_), F_, [False] * 6)

    def hexcap(cx, cz, R0, y, mat):
        V_ = [(cx + R0 * math.cos(t_), y, cz + R0 * math.sin(t_)) for t_ in ang6]
        G.add(mat, np.array(V_), [tuple(range(6))], [False])

    for r_ in range(rows):
        cols = 9 if r_ % 2 == 0 else 8
        for c_ in range(cols):
            x = -(cols - 1) * px_ / 2 + c_ * px_
            z = FZ + 0.1 + R_ + r_ * py_
            hexring(x, z, R_ * 0.97, R_ * 0.97, -0.03, -0.1, "main_trim")
            hexcap_m = None
            if PT.ON:
                # Every socket is dark steel in the plate. A lit cell is live, so the vault can fill while you watch.
                hexcap(x, z, R_ * 0.8, -0.035, "socket")
                hexring(x, z, R_ * 0.97, R_ * 0.8, -0.1, -0.035, "main_trim")
                PT.spot("cell", st_world((x, -0.088, z)), scale=R_ * 0.9 * VAULT_SC, yaw=VAULT_YAW)
                continue
            if c_ < fill[r_]:
                v = noise.noise(Vector((c_ * 0.8 + hot_seed, r_ * 0.8, hot_seed))) + random.uniform(-0.2, 0.2)
                hexcap_m = "cell_b" if v > 0.2 else ("cell_c" if v < -0.25 else "cell_a")
                hexcap(x, z, R_ * 0.8, -0.05, hexcap_m)
            else:
                hexcap(x, z, R_ * 0.8, -0.035, "glass_main")
                if r_ == 4 and c_ == fill[r_]:
                    FRONT = (x, -0.03, z)
            hexring(x, z, R_ * 0.97, R_ * 0.8, -0.1, -0.05 if c_ < fill[r_] else -0.035, "main_trim")
    # cornice, deep snow, icicles
    box("main_trim", (0, D / 2, ZB + H + 0.05), (W + 0.62, D + 0.62, 0.14), r=0.025)
    pillow((0, D / 2, ZB + H + 0.11), W + 0.6, D + 0.6, 0.3, n=28)
    icicles((-W / 2 - 0.3, -0.36, ZB + H), (W / 2 + 0.3, -0.36, ZB + H), 54, 0.26)
    icicles((W / 2 + 0.34, -0.3, ZB + H), (W / 2 + 0.34, D + 0.3, ZB + H), 30, 0.22)
    # the side in shade: panel seams, a strip of warm slit windows, fins that shed the vault's heat
    for z_ in np.arange(ZB + 0.9, ZB + H, 0.86):
        box("main_trim", (W / 2 + 0.004, D / 2, float(z_)), (0.012, D - 0.02, 0.018), r=0.0)
    for y_ in np.arange(0.5, D, 0.7):
        box("win_warm", (W / 2 + 0.006, float(y_), ZB + 1.3), (0.008, 0.08, 0.5), r=0.0)
        box("main_trim", (W / 2 + 0.012, float(y_), ZB + 1.3), (0.012, 0.22, 0.56), r=0.0) if False else None
    for y_ in np.arange(0.35, D - 0.2, 0.24):
        box("main_frame", (W / 2 + 0.08, float(y_), ZB + 3.7), (0.14, 0.05, 1.5), r=0.006)
    pillow((W / 2 + 0.09, D / 2, ZB + 4.46), 0.18, D - 0.5, 0.05, n=10)
    # roof gear: vents and one uplink mast. The data leaves from here.
    mx_, my_ = 1.7, 1.9
    cyl("steel", (mx_, my_, ZB + H + 1.1), (mx_, my_, ZB + H + 1.85), 0.05, seg=10, r2=0.016)
    for z_, l_ in ((1.38, 0.3), (1.58, 0.2)):
        cyl("steel", (mx_ - l_, my_, ZB + H + z_), (mx_ + l_, my_, ZB + H + z_), 0.009, seg=5)
    sphere("beacon", (mx_, my_, ZB + H + 1.89), 0.04, seg=10, rings=6)
    # the lift: two rails up the face, a bridge at the row being filled, a dark platform for the white lead
    # wide enough that neither rail cuts across the lead, from where the camera stands
    gx0, gx1, gy = 1.05, 3.9, -1.5
    ZP = FZ + 0.1 + R_ + 3.5 * py_
    for gx in (gx0, gx1):
        box("tower2", (gx, gy, ZB + (H + 0.3) / 2), (0.16, 0.16, H + 0.3), r=0.012)
        box("tower2", (gx, gy / 2, ZB + H + 0.1), (0.1, -gy, 0.1), r=0.01)
        for z_ in np.arange(ZB + 0.3, ZB + H, 0.42):
            box("rail", (gx, gy - 0.085, float(z_)), (0.1, 0.012, 0.02), r=0.0)
        box("main_trim", (gx, gy, ZB + 0.08), (0.42, 0.42, 0.16), r=0.02)
    box("tower2", ((gx0 + gx1) / 2, gy, ZB + H + 0.3), (gx1 - gx0 + 0.16, 0.14, 0.14), r=0.012)
    pillow(((gx0 + gx1) / 2, gy, ZB + H + 0.37), gx1 - gx0 + 0.2, 0.2, 0.05, n=10)
    box("tower2", ((gx0 + gx1) / 2, gy, ZP - 0.14), (gx1 - gx0 + 0.3, 0.2, 0.16), r=0.015)
    PX, PY = (gx0 + gx1) / 2, gy + 0.32
    lathe("plinth", (PX, PY, ZP - 0.08), [(0.95, 0.0), (0.95, 0.08), (0.91, 0.1), (0.001, 0.1)], seg=56)
    lathe("led_on", (PX, PY, ZP + 0.021), [(0.74, 0.0), (0.8, 0.0)], seg=56)
    for s_ in (-1, 1):
        cyl("rail", (PX + s_ * 0.8, PY, ZP - 0.08), (PX + s_ * 1.15, gy, ZP - 0.6), 0.03, seg=7)
    bs_ = 1.85
    fw = bot_world_dir(C_CAM, VAULT_O, VAULT_YAW)
    # turned towards its work, still showing both eyes
    bot((PX, PY, ZP + 0.02 + bs_ * 0.47), bs_, "sphere", facing=math.atan2(fw[0] - 0.16, -fw[1] - 0.02))
    # the core it is about to slot, floating towards the empty cell
    if FRONT is not None and not PT.ON:
        fx, _fy, fz = FRONT
        core((fx, -2.2, fz), (fx, -0.5, fz), r=0.36)
        lathe("led_on", (fx, -1.2, fz), [(0.42, -0.014), (0.46, 0.0), (0.42, 0.014)], seg=28, rx=math.pi / 2)
    PT.spot("slot_home", st_world((PX - 1.4, PY - 0.55, ZP + 0.95)))
    PT.spot("vault_mast", st_world((mx_, my_, ZB + H + 1.89)))
    PT.spot("vault_centre", st_world((0, -0.3, FZ + FH / 2)))
    # The lit cells throw warm light onto the deck and the snow lip.
    _spill = bpy.data.lights.new("vault_spill", "POINT")
    _spill.energy = 260.0
    _spill.color = (1.0, 0.42, 0.13)
    _spill.shadow_soft_size = 1.6
    _spill_o = bpy.data.objects.new("vault_spill", _spill)
    bpy.context.collection.objects.link(_spill_o)
    _spill_o.location = st_world((0, -2.0, FZ + FH * 0.28))
    # waiting stock on the dock: what the sled has already brought
    for ox, oy in ((-2.9, -1.1), (-1.25, -1.5)):
        box("timber2", (ox, oy, ZB + 0.06), (1.35, 1.75, 0.12), r=0.01)
        n_ = 0
        for lv, cnt in enumerate((4, 3, 2) if ox < -2 else (4, 3)):
            for k in range(cnt):
                x_ = ox + (k - (cnt - 1) / 2) * 0.31
                with PT.drop():
                    core((x_, oy - 0.78, ZB + 0.27 + lv * 0.27), (x_, oy + 0.78, ZB + 0.27 + lv * 0.27), r=0.15)
                PT.spot("stock", st_world((x_, oy, ZB + 0.27 + lv * 0.27)), scale=1.56 * VAULT_SC, yaw=VAULT_YAW)
    # warm light washing the face from the dock
    point((-1.9, -2.0, ZB + 0.5), 13.0, col=(1.0, 0.62, 0.3), r=0.2)
    point((2.4, -2.4, ZB + 0.8), 9.0, col=(1.0, 0.62, 0.3), r=0.2)
    for x_ in np.linspace(-3.4, 3.4, 9):
        cyl("rail", (float(x_), -2.3, ZB), (float(x_), -2.3, ZB + 0.26), 0.012, seg=6)
        sphere("lamp", (float(x_), -2.3, ZB + 0.28), 0.02, seg=8, rings=5)


def _vlocal(x, y):
    c, s_ = math.cos(VAULT_YAW), math.sin(VAULT_YAW)
    x, y = x * VAULT_SC, y * VAULT_SC
    return (VAULT_O[0] + x * c - y * s_, VAULT_O[1] + x * s_ + y * c)


def ramp():
    """World coordinates. The rail from the river up the bluff, with a cart of cores on the way."""
    zt = PLATEAU_Z * BLUFF_SZ + 0.24
    top = np.array((*_vlocal(-1.0, -2.75), zt))
    foot = np.array((0.6, 8.6, 0.06))
    along = top - foot
    az = math.atan2(along[1], along[0]) + math.pi / 2
    side = np.array((math.cos(az), math.sin(az), 0.0))
    u = along / np.linalg.norm(along)
    n_up = np.cross(u, side)
    if n_up[2] < 0:
        n_up = -n_up
    pitch = math.atan2(along[2], math.hypot(along[0], along[1]))
    for sgn in (-1, 1):
        cyl("steel", foot + side * sgn * 0.42, top + side * sgn * 0.42, 0.035, seg=8)
        cyl("rail", foot + side * sgn * 0.62 + n_up * 0.5, top + side * sgn * 0.62 + n_up * 0.5, 0.012, seg=6)
    NST = 30
    for i in range(NST):
        q = foot + along * (i + 0.5) / NST
        cyl("timber2", q - side * 0.6 - n_up * 0.04, q + side * 0.6 - n_up * 0.04, 0.045, seg=6)
        if i % 3 == 0:
            pillow(q - n_up * 0.0, 0.6, 0.1, 0.02, n=5, rz=az)
    for t in np.linspace(0.08, 0.92, 11):
        q = foot + along * t
        for sgn in (-1, 1):
            a_ = q + side * sgn * 0.62
            cyl("rail", a_, a_ + n_up * 0.5, 0.009, seg=5)
            x_, y_ = float(a_[0]), float(a_[1])
            lx, ly = (x_ - BLUFF[0]) / BLUFF_S, (y_ - BLUFF[1]) / BLUFF_S
            gz = max(rock_z(lx, ly, 0.0) * BLUFF_SZ, ground_z(x_, y_), 0.0)
            if a_[2] - gz > 0.1:
                cyl("tower2", a_, (x_, y_, gz - 0.05), 0.03, seg=7)
    for t in (0.14, 0.34, 0.54, 0.74, 0.94):
        q = foot + along * t + side * 0.62 + n_up * 0.54
        sphere("lamp", q, 0.022, seg=8, rings=5)
    # cart with a load, on its cable. In the plate the cable stays and the cart is live, starting at the foot.
    C = foot + along * (0.1 if PT.ON else 0.56) + n_up * 0.14
    C_end = foot + along * 0.86 + n_up * 0.14
    PT.path("ramp", [C, C_end])
    with PT.actor("cart_load", pivot=C):
        for k, sy in enumerate((-0.28, 0.0, 0.28)):
            p0 = C + u * -0.8 + side * sy + n_up * 0.2
            p1 = C + u * 0.8 + side * sy + n_up * 0.2
            core(p0, p1, r=0.13)
        p0 = C + u * -0.8 + side * 0.14 + n_up * 0.44
        core(p0, p0 + u * 1.6, r=0.13)
        p0 = C + u * -0.8 - side * 0.14 + n_up * 0.44
        core(p0, p0 + u * 1.6, r=0.13)
    with PT.actor("cart", pivot=C):
        for off in (-0.85, 0.85):
            cyl("tower2", C + u * off - side * 0.52, C + u * off + side * 0.52, 0.05, seg=8)
        for off in (-0.6, 0.0, 0.6):
            cyl("timber", C + u * off - side * 0.5 + n_up * 0.04, C + u * off + side * 0.5 + n_up * 0.04, 0.05, seg=6)
    cyl("rail", foot + n_up * 0.2, top + n_up * 0.1, 0.009, seg=5, cap=False)
    PT.spot("cart_top", top + n_up * 0.5)
    # the far end of the tow line: a post at the foot of the rail
    post = foot + np.array((-0.55, 0.62, 0.0))
    cyl("rail", (post[0], post[1], 0.0), (post[0], post[1], 0.62), 0.035, seg=8)
    sphere("lamp", (post[0], post[1], 0.65), 0.03, seg=8, rings=5)
    PT.spot("post_rope", (post[0], post[1], 0.42))
    box("crate2", top + u * 0.1 + n_up * 0.25, (0.7, 0.7, 0.42), r=0.03, rz=az)


# ---------- rock: the bluff the vault stands on, and a few outcrops down the valley ----------
def rock_at(seed, x, y, s, sz, z=0.0, rz=0.0):
    global BVH
    o, bvh = build_rock(seed)
    o.location = (x, y, z)
    o.scale = (s, s, sz)
    o.rotation_euler = (0, 0, rz)
    return o, bvh


_bo, BVH = rock_at(7.0, BLUFF[0], BLUFF[1], BLUFF_S, BLUFF_SZ, z=-0.1)
_BLUFF_BVH = BVH
# The old flat topped outcrops read as the same prop four times. Now broken boulders, a different size at each place.
_OUTCROPS = [(19.0, -12.4, 4.6, 0.62), (43.0, 12.0, -1.6, 0.36), (31.0, -7.0, -6.2, 0.3)]
BVH = _BLUFF_BVH
print("rocks built", flush=True)


def boulders(places):
    BM = bmesh.new()
    bmesh.ops.create_icosphere(BM, subdivisions=3, radius=1)
    bv = np.array([v.co[:] for v in BM.verts])
    idx_ = {v: i for i, v in enumerate(BM.verts)}
    bf = [tuple(idx_[v] for v in f.verts) for f in BM.faces]
    BM.free()
    VV, FF, AA, n_ = [], [], [], 0
    for x, y, s_b in places:
        off = Vector((random.uniform(0, 50), random.uniform(0, 50), 0))
        q = np.array([np.array(v) * (1 + 0.46 * noise.noise(Vector(v) * 1.5 + off) + 0.1 * noise.noise(Vector(v) * 5.0 + off)) for v in bv])
        sq = np.array((random.uniform(0.8, 1.4), random.uniform(0.8, 1.4), random.uniform(0.55, 0.95)))
        w = q * s_b * sq
        w = w @ _rot(random.uniform(0, 6.28)).T + np.array((x, y, max(ground_z(x, y), 0.0) + s_b * 0.12))
        VV.append(w)
        FF.extend([tuple(i + n_ for i in f) for f in bf])
        AA.append(np.clip((q[:, 2] - 0.3) / 0.3, 0, 1))
        n_ += len(q)
    mesh_obj("boulders", np.concatenate(VV), FF, "rock", attr=np.concatenate(AA).astype(np.float32))


_pl = []
random.seed(21)
for _ in range(1400):
    x, y = random.uniform(-26, 26), random.uniform(-30, 22)
    d = riv_d(x, y)
    if -0.5 < d < 1.4 and random.random() < 0.34 and math.hypot(x - DRILL[0], y - DRILL[1]) > 6.0:
        _pl.append((x, y, 0.06 + random.random() ** 2.6 * 0.5))
_pl = _pl[:150]
random.seed(33)
for _s, _x, _y, _sc in _OUTCROPS:
    for _k in range(int(4 + _sc * 11)):
        _a, _rr = random.uniform(0, 6.28), random.random() ** 0.7 * _sc * 3.0
        _pl.append((_x + _rr * math.cos(_a), _y + _rr * math.sin(_a), (0.18 + random.random() ** 1.8 * 1.25) * _sc * (1.25 - _rr / (_sc * 3.6))))
boulders(_pl)


# ---------- stations ----------
def bot_world_dir(cam, at, yaw):
    """The unit vector towards the camera, in the station's local frame."""
    dx, dy = cam.x - at[0], cam.y - at[1]
    L_ = math.hypot(dx, dy)
    dx, dy = dx / L_, dy / L_
    c, s_ = math.cos(-yaw), math.sin(-yaw)
    return (dx * c - dy * s_, dx * s_ + dy * c)


def station(fn, x, y, z=0.0, yaw=0.0, key=None, color=None, state="working", sc=1.0):
    global G, CUR
    before = set(bpy.data.objects)
    G = Geo()
    CUR = bot_mats(key, color, state)[0] if key else {}
    CUR_ST.update(x=float(x), y=float(y), z=float(z), yaw=float(yaw), sc=float(sc), key=key)
    fn()
    G.build()
    root = bpy.data.objects.new("st_" + (key or fn.__name__), None)
    bpy.context.collection.objects.link(root)
    root.location = (x, y, z)
    root.rotation_euler = (0, 0, yaw)
    root.scale = (sc, sc, sc)
    for o in bpy.data.objects:
        if o not in before and o is not root and o.parent is None:
            o.parent = root
    print("built", key or fn.__name__, flush=True)
    return root


# the sled's place on the route, and which way it heads
_si = 112
SLED_XY = (float(RIV[_si][0]) + 0.1, float(RIV[_si][1]))
_sd = RIV[_si + 3] - RIV[_si - 3]
SLED_YAW = math.atan2(_sd[1], _sd[0]) - math.pi / 2
DRILL_YAW = 0.22

random.seed(11)
station(drill_site, DRILL[0], DRILL[1], yaw=DRILL_YAW, key="orange", color=(0.86, 0.2, 0.012), state="working")
station(stakes, 0, 0, key="orange2", color=(1.0, 0.36, 0.05), state="idle")
if PT.ON:
    # The hauling post stays put and live sleds run past it, so the bot keeps its station.
    station(tow_post, float(TOW[0]), float(TOW[1]), yaw=TOW_YAW, key="pink", color=(0.86, 0.035, 0.26), state="working")
else:
    station(sled, SLED_XY[0], SLED_XY[1], yaw=SLED_YAW, key="pink", color=(0.86, 0.035, 0.26), state="working", sc=1.2)
station(vault_b, VAULT_O[0], VAULT_O[1], z=PLATEAU_Z * BLUFF_SZ - 0.1 + 0.02, yaw=VAULT_YAW, key="main", color=(0.9, 0.91, 0.93), state="main", sc=VAULT_SC)
station(ramp, 0, 0, key="ramp", color=(1.0, 0.8, 0.5), state="main")


# ---------- the route: one lit line on the ice, sled runner tracks behind the sled ----------
def route():
    MATS["route"] = pbsdf("route", (0, 0, 0), 0.4, emis=(1.0, 0.56, 0.22), emis_str=3.0)
    MATS["track"] = pbsdf("track", (0.26, 0.34, 0.42), 0.7)
    i0, i1 = 76, len(RIV) - 3
    fine = _catmull([tuple(p) for p in LANE_UP[::2]], 8)
    ribbon("route", [(float(q[0]), float(q[1]), 0.012) for q in fine], width=0.055)
    PT.path("sled_up", [(float(q[0]), float(q[1]), 0.02) for q in LANE_UP[8:]])
    PT.path("sled_down", [(float(q[0]), float(q[1]), 0.02) for q in LANE_DOWN[::-1]])
    PT.spot("line_head", (float(LANE_UP[8][0]), float(LANE_UP[8][1]), 0.02))
    if PT.ON:
        return
    # tracks: two grooves behind the sled, none ahead of it
    tr = [q for q in fine if True]
    n_ = int(len(tr) * (_si - i0) / (i1 - i0)) - 12
    for off in (-0.57, 0.57):
        P_ = []
        for a_, b_ in zip(tr[:n_], tr[1:n_ + 1]):
            d_ = b_ - a_
            d_ /= np.linalg.norm(d_) + 1e-9
            P_.append((float(a_[0] - d_[1] * off), float(a_[1] + d_[0] * off), 0.01))
        ribbon("track", P_, width=0.04)


G = Geo()
CUR = {}
route()
G.build()

# ---------- pines ----------
def pine_mesh(seed, h=1.6, tiers=13):
    rnd = random.Random(seed)
    V, F, A = [], [], []
    base = 0.0
    for t in range(tiers):
        f = t / tiers
        r0 = (0.46 * (1 - f) ** 1.1 + 0.06) * h / 1.6
        z0 = base + h * 0.09 + h * 0.76 * f
        z1 = z0 + h * 0.2 * (1 - 0.45 * f)
        # Many thin boughs of uneven reach, in lobes round the trunk. Few even ones were what read as low poly.
        n = 46
        s = len(V)
        lobe, lobe_a = rnd.uniform(0.08, 0.2), rnd.uniform(0, 6.28)
        for i in range(n):
            a = 2 * math.pi * i / n + rnd.uniform(-0.05, 0.05)
            spike = (0.66 if i % 2 else 1.0) * rnd.uniform(0.74, 1.14) * (1.0 + lobe * math.sin(3 * a + lobe_a))
            V.append((r0 * spike * math.cos(a), r0 * spike * math.sin(a), z0 - rnd.uniform(0, 0.055) * h * (1 if i % 2 == 0 else 0)))
            A.append(0.0)
        for i in range(n):
            a = 2 * math.pi * i / n
            V.append((r0 * 0.5 * spike * math.cos(a), r0 * 0.5 * spike * math.sin(a), (z0 + z1) * 0.5))
            A.append(0.62)
        V.append((0, 0, z1))
        A.append(1.0)
        tip = len(V) - 1
        for i in range(n):
            j = (i + 1) % n
            F.append((s + i, s + j, s + n + j, s + n + i))
            F.append((s + n + i, s + n + j, tip))
    o_me = bpy.data.meshes.new(f"pine{seed}")
    o_me.from_pydata(V, [], F)
    o_me.polygons.foreach_set("use_smooth", [True] * len(o_me.polygons))
    a = o_me.attributes.new("snow", "FLOAT", "POINT")
    A = [min(1.0, x + (0.45 if rnd.random() < 0.3 else 0.0)) for x in A]
    a.data.foreach_set("value", A)
    o_me.update()
    o_me.materials.append(MATS["pine"])
    return o_me


PINES = [pine_mesh(s) for s in (1, 2, 3, 4, 5)]
FOREST = []


def plant(x, y, h, z=None):
    o = bpy.data.objects.new("pine", random.choice(PINES))
    z = ground_z(x, y) if z is None else z
    o.location = (x, y, z - 0.05)
    s = h / 1.6
    o.scale = (s * random.uniform(0.9, 1.15), s * random.uniform(0.9, 1.15), s)
    o.rotation_euler = (0, 0, random.uniform(0, 6.28))
    bpy.context.collection.objects.link(o)
    FOREST.append((o.location.x, o.location.y, o.location.z))


def hides_work(x, y, h, z):
    """Would this tree stand in front of the river or the bluff, seen from the camera?"""
    dx, dy = x - C_CAM.x, y - C_CAM.y
    R = math.hypot(dx, dy)
    ux, uy = dx / R, dy / R
    ext = R * (h + z) / max(C_CAM.z - (h + z), 2.0)
    for k in range(0, 9):
        qx, qy = x + ux * ext * k / 8, y + uy * ext * k / 8
        if riv_d(qx, qy) < 0.45:
            return True
        if math.hypot(qx - BLUFF[0], qy - BLUFF[1]) < 5.4:
            return True
    # keep the low sun on the working spots
    sx, sy = 0.84 / 0.913, 0.36 / 0.913
    L_ = (h + z) / 0.45
    for k in range(0, 9):
        qx, qy = x + sx * L_ * k / 8, y + sy * L_ * k / 8
        if math.hypot(qx - TOW[0], qy - TOW[1]) < 4.2 or math.hypot(qx - SLED_XY[0], qy - SLED_XY[1]) < 4.2 or math.hypot(qx - DRILL[0], qy - DRILL[1]) < 5.0:
            return True
    return False


random.seed(5)
_planted = 0
_cf = (C_TG - C_CAM).normalized()
_cr = _cf.cross(Vector((0, 0, 1))).normalized()
for _ in range(26000):
    x, y = random.uniform(-64, 64), random.uniform(-30, 84)
    d = riv_d(x, y)
    if d < 1.15:
        continue
    if math.hypot(x - BLUFF[0], y - BLUFF[1]) < 8.4:
        continue
    if any(math.hypot(x - o_[1], y - o_[2]) < 3.4 * o_[3] for o_ in _OUTCROPS):
        continue
    # The left of the frame stood as one dark mass: thin it out and open glades where the snow can catch the sun.
    if x < 2.0 and y < 44.0:
        _left = smooth((2.0 - x) / 12.0)
        if random.random() < 0.26 * _left:
            continue
        if noise.noise(Vector((x * 0.13, y * 0.13, 5.0))) < -0.08 and d < 20.0 and random.random() < 0.8 * _left:
            continue
    if noise.noise(Vector((x * 0.17, y * 0.17, 2.0))) < -0.22 and d < 9.0:
        continue
    h = 1.2 + (random.uniform(2.4, 4.4) - 1.2) * smooth((d - 0.6) / 7.0)
    z = ground_z(x, y)
    # Bottom right, anything this close to the lens falls inside the blur and turns into a pale smear.
    _dv = Vector((x, y, z)) - C_CAM
    if _dv.dot(_cf) < 39.5 and _dv.dot(_cr) > 0.0:
        continue
    if hides_work(x, y, h, z):
        continue
    plant(x, y, h, z=z)
    _planted += 1
# the soft framing pines near the lens, bottom corners
_f = (C_TG - C_CAM).normalized()
_r = _f.cross(Vector((0, 0, 1))).normalized()
_u = _r.cross(_f)
_k = LENS / 36.0 * 1920.0
# The right hand ones melted into one large pale mound, so only the left corner keeps its framing.
for _px, _py, _D in [(70, 930, 30.5), (250, 1035, 30.0), (-60, 800, 32.0), (150, 1120, 29.0), (-120, 1040, 30.0)]:
    _p = C_CAM + _f * _D + _r * ((_px - 960) * _D / _k) + _u * ((540 - _py) * _D / _k)
    _gz = ground_z(_p.x, _p.y)
    plant(_p.x, _p.y, max(_p.z - _gz, 3.0), z=_gz)
print("forest planted", _planted, flush=True)


# ---------- aurora ----------
def aurora_sheet():
    """A folded curtain across the top of the frame, from over the left forest to behind the vault. The camera looks down, so the sky itself is out of shot."""
    ctrl = [(-34.0, 1.0), (-22.0, 6.0), (-10.0, 10.0), (0.0, 15.0), (8.0, 22.0), (20.0, 26.0), (36.0, 24.0), (52.0, 18.0)]
    path_ = _catmull(ctrl, 22)
    V, F = [], []
    for i, q in enumerate(path_):
        fold = 1.1 * math.sin(i * 0.31) + 0.5 * math.sin(i * 0.83 + 1.0)
        x, y = float(q[0]), float(q[1]) + fold
        z0 = AURORA_Z0 - 0.6 + 0.5 * math.sin(i * 0.17) + 0.05 * max(y - 10.0, 0.0)
        V += [(x, y, z0), (x, y, 34.0)]
    for i in range(len(path_) - 1):
        F.append((2 * i, 2 * i + 2, 2 * i + 3, 2 * i + 1))
    return mesh_obj("aurora_sheet", np.array(V), F, "aurora")


_ao = aurora_sheet()
_ao.visible_diffuse = False
_ao.visible_shadow = False
_ao.hide_render = True    # the frame has no sky for it; over the trees it read as a light leak

# ---------- world ----------
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
c.elements[0].position, c.elements[0].color = 0.0, (0.30, 0.34, 0.52, 1)
c.elements[1].position, c.elements[1].color = 1.0, (0.012, 0.03, 0.09, 1)
c.elements.new(0.14).color = (0.15, 0.24, 0.5, 1)
c.elements.new(0.5).color = (0.03, 0.115, 0.24, 1)
nt.links.new(sep.outputs["Z"], rp.inputs["Fac"])
# warm band on the sun side
SUN_DIR = Vector((-0.84, -0.36, 0.41)).normalized()
dot = nt.nodes.new("ShaderNodeVectorMath")
dot.operation = "DOT_PRODUCT"
dot.inputs[1].default_value = SUN_DIR
nt.links.new(tc.outputs["Generated"], dot.inputs[0])
wr = nt.nodes.new("ShaderNodeValToRGB")
wr.color_ramp.elements[0].position = 0.88
wr.color_ramp.elements[0].color = (0, 0, 0, 1)
wr.color_ramp.elements[1].position = 0.98
wr.color_ramp.elements[1].color = (1.1, 0.5, 0.2, 1)
nt.links.new(dot.outputs["Value"], wr.inputs["Fac"])
# aurora curtains
wv = nt.nodes.new("ShaderNodeTexWave")
wv.wave_type = "BANDS"
wv.bands_direction = "X"
wv.inputs["Scale"].default_value = 1.15
wv.inputs["Distortion"].default_value = 5.5
wv.inputs["Detail"].default_value = 3
wv.inputs["Detail Scale"].default_value = 1.1
nt.links.new(tc.outputs["Generated"], wv.inputs["Vector"])
ar = nt.nodes.new("ShaderNodeValToRGB")
ar.color_ramp.elements[0].position = 0.62
ar.color_ramp.elements[1].position = 0.95
nt.links.new(wv.outputs["Fac"], ar.inputs["Fac"])
mp = nt.nodes.new("ShaderNodeMapping")
mp.inputs["Scale"].default_value = (10, 10, 0.7)
nt.links.new(tc.outputs["Generated"], mp.inputs["Vector"])
nz = nt.nodes.new("ShaderNodeTexNoise")
nz.inputs["Scale"].default_value = 2.6
nz.inputs["Detail"].default_value = 4
nt.links.new(mp.outputs[0], nz.inputs["Vector"])
nzr = nt.nodes.new("ShaderNodeValToRGB")
nzr.color_ramp.elements[0].position = 0.35
nzr.color_ramp.elements[1].position = 0.75
nt.links.new(nz.outputs["Fac"], nzr.inputs["Fac"])
el = nt.nodes.new("ShaderNodeValToRGB")
ec = el.color_ramp
ec.elements[0].position, ec.elements[0].color = 0.08, (0, 0, 0, 1)
ec.elements[1].position, ec.elements[1].color = 0.95, (0, 0, 0, 1)
ec.elements.new(0.32).color = (1, 1, 1, 1)
ec.elements.new(0.7).color = (0.8, 0.8, 0.8, 1)
nt.links.new(sep.outputs["Z"], el.inputs["Fac"])
m1 = nt.nodes.new("ShaderNodeMath")
m1.operation = "MULTIPLY"
nt.links.new(ar.outputs["Color"], m1.inputs[0])
nt.links.new(nzr.outputs["Color"], m1.inputs[1])
m2 = nt.nodes.new("ShaderNodeMath")
m2.operation = "MULTIPLY"
nt.links.new(m1.outputs[0], m2.inputs[0])
nt.links.new(el.outputs["Color"], m2.inputs[1])
acol = nt.nodes.new("ShaderNodeMix")
acol.data_type = "RGBA"
acol.blend_type = "MULTIPLY"
acol.inputs["Factor"].default_value = 1.0
nt.links.new(m2.outputs[0], acol.inputs["A"])
acol.inputs["B"].default_value = (0.22, 3.0, 1.2, 1)
add1 = nt.nodes.new("ShaderNodeMix")
add1.data_type = "RGBA"
add1.blend_type = "ADD"
add1.inputs["Factor"].default_value = 1.0
nt.links.new(rp.outputs["Color"], add1.inputs["A"])
nt.links.new(wr.outputs["Color"], add1.inputs["B"])
add2 = nt.nodes.new("ShaderNodeMix")
add2.data_type = "RGBA"
add2.blend_type = "ADD"
add2.inputs["Factor"].default_value = 1.0
nt.links.new(add1.outputs["Result"], add2.inputs["A"])
nt.links.new(acol.outputs["Result"], add2.inputs["B"])
nt.links.new(add2.outputs["Result"], bg.inputs["Color"])
bg.inputs["Strength"].default_value = 0.92

# ---------- sun ----------
sun = bpy.data.lights.new("sun", "SUN")
sun.energy = 9.6
sun.color = (1.0, 0.68, 0.4)
sun.angle = math.radians(2.2)
so = bpy.data.objects.new("sun", sun)
so.rotation_euler = SUN_DIR.to_track_quat("Z", "Y").to_euler()
bpy.context.collection.objects.link(so)
# a window for glossy things to mirror. It adds no diffuse light, so the snow and the shadows do not change.
win = bpy.data.lights.new("window", "AREA")
win.shape = "RECTANGLE"
win.size, win.size_y = 16.0, 10.0
win.energy = 1300.0
win.color = (1.0, 0.93, 0.84)
wo = bpy.data.objects.new("window", win)
wo.location = (-22.0, -30.0, 34.0)
wo.rotation_euler = (Vector((2.0, 0.0, 2.0)) - wo.location).to_track_quat("-Z", "Y").to_euler()
bpy.context.collection.objects.link(wo)
wo.visible_diffuse = False
wo.visible_transmission = False
wo.visible_volume_scatter = False
hot = bpy.data.lights.new("glint", "AREA")
hot.shape = "RECTANGLE"
hot.size, hot.size_y = 10.0, 7.0
hot.energy = float(OPT.get("glint", 12000.0))
hot.color = (1.0, 0.95, 0.88)
ho = bpy.data.objects.new("glint", hot)
_gd = Vector((-0.62, -0.55, 0.62)).normalized()
ho.location = Vector((0.0, 0.0, 2.0)) + _gd * 40.0
ho.rotation_euler = (-_gd).to_track_quat("-Z", "Y").to_euler()
bpy.context.collection.objects.link(ho)
ho.visible_diffuse = False
ho.visible_transmission = False
ho.visible_volume_scatter = False

# ---------- camera ----------
cd = bpy.data.cameras.new("cam")
cd.lens = LAY["lens"]
cd.sensor_width = 36
co = bpy.data.objects.new("cam", cd)
CP = LAY["cam"]
TG = LAY["target"]
co.location = CP
co.rotation_euler = (TG - CP).to_track_quat("-Z", "Y").to_euler()
bpy.context.collection.objects.link(co)
bpy.context.scene.camera = co
cd.dof.use_dof = True
cd.dof.focus_distance = LAY["focus"]
cd.dof.aperture_fstop = float(OPT.get("fstop", 0.45))
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
sc.cycles.sample_clamp_direct = 80.0
sc.cycles.sample_clamp_indirect = 8.0
sc.cycles.volume_bounces = 1
sc.cycles.volume_max_steps = 256
sc.render.resolution_x = WIDTH
sc.render.resolution_y = round(WIDTH * 9 / 16)
sc.render.resolution_percentage = 100
sc.render.image_settings.file_format = "PNG"
sc.render.filepath = OUT
sc.view_settings.view_transform = "AgX"
sc.view_settings.look = "AgX - Punchy"
sc.view_settings.exposure = 0.38
try:
    tree = bpy.data.node_groups.new("post", "CompositorNodeTree")
    tree.interface.new_socket(name="Image", in_out="OUTPUT", socket_type="NodeSocketColor")
    sc.compositing_node_group = tree
    rl = tree.nodes.new("CompositorNodeRLayers")
    gl = tree.nodes.new("CompositorNodeGlare")
    gl.inputs["Type"].default_value = "Bloom"
    gl.inputs["Quality"].default_value = "High"
    for nm, val in (("Threshold", 2.4), ("Smoothness", 0.7), ("Strength", 0.42), ("Saturation", 1.15), ("Size", 0.62)):
        gl.inputs[nm].default_value = val
    ou = tree.nodes.new("NodeGroupOutput")
    src_out = rl.outputs["Image"]
    try:
        bpy.context.view_layer.use_pass_mist = True
        ms = bpy.context.scene.world.mist_settings
        ms.start, ms.depth, ms.falloff = 60.0, 60.0, "QUADRATIC"
        mr = tree.nodes.new("ShaderNodeMapRange")
        mr.inputs["To Max"].default_value = 0.42
        fg = tree.nodes.new("ShaderNodeMix")
        fg.data_type = "RGBA"
        fg.inputs["B"].default_value = (0.03, 0.075, 0.15, 1)
        tree.links.new(rl.outputs["Mist"], mr.inputs["Value"])
        tree.links.new(mr.outputs[0], fg.inputs["Factor"])
        tree.links.new(rl.outputs["Image"], fg.inputs["A"])
        src_out = fg.outputs["Result"]
        print("HAZE on", flush=True)
    except Exception as ex2_:
        print("HAZE SKIPPED", repr(ex2_), flush=True)
    # Cycles has no tilt focus. The lens keeps every world sharp, this blurs what lies outside them by depth.
    try:
        bpy.context.view_layer.use_pass_z = True
        F_ = LAY["focus"]
        px_ = WIDTH / 1920.0
        NEAR_R, FAR_R = 30.0 * px_, 30.0 * px_
        rfar = tree.nodes.new("ShaderNodeMapRange")
        rfar.inputs["From Min"].default_value = F_ * 1.36
        rfar.inputs["From Max"].default_value = F_ * 1.62
        rfar.inputs["To Max"].default_value = FAR_R
        tree.links.new(rl.outputs["Depth"], rfar.inputs["Value"])
        rnear = tree.nodes.new("ShaderNodeMapRange")
        rnear.inputs["From Min"].default_value = F_ * 0.77
        rnear.inputs["From Max"].default_value = F_ * 0.64
        rnear.inputs["To Max"].default_value = NEAR_R
        tree.links.new(rl.outputs["Depth"], rnear.inputs["Value"])
        # soften the near radius outwards, so a pine's edge melts into the ice behind it
        bl = tree.nodes.new("CompositorNodeBlur")
        print("BLUR inputs", [i.name for i in bl.inputs], flush=True)
        if "Size" in bl.inputs:
            try:
                bl.inputs["Size"].default_value = (30.0 * px_, 30.0 * px_)
            except Exception:
                bl.inputs["Size"].default_value = 30.0 * px_
        tree.links.new(rnear.outputs[0], bl.inputs["Image"])
        dil = tree.nodes.new("ShaderNodeMath")
        dil.operation = "MULTIPLY"
        dil.inputs[1].default_value = 1.7
        tree.links.new(bl.outputs[0], dil.inputs[0])
        m1_ = tree.nodes.new("ShaderNodeMath")
        m1_.operation = "MAXIMUM"
        tree.links.new(dil.outputs[0], m1_.inputs[0])
        tree.links.new(rnear.outputs[0], m1_.inputs[1])
        m2_ = tree.nodes.new("ShaderNodeMath")
        m2_.operation = "MAXIMUM"
        tree.links.new(m1_.outputs[0], m2_.inputs[0])
        tree.links.new(rfar.outputs[0], m2_.inputs[1])
        df = tree.nodes.new("CompositorNodeDefocus")
        print("DEFOCUS inputs", [i.name for i in df.inputs], "props", [p.identifier for p in df.bl_rna.properties if not p.is_readonly][:30], flush=True)
        df.use_zbuffer = False
        df.z_scale = 1.0
        df.blur_max = max(FAR_R, NEAR_R) * 1.1
        df.bokeh = "CIRCLE"
        tree.links.new(src_out, df.inputs[0])
        tree.links.new(m2_.outputs[0], df.inputs[1])
        src_out = df.outputs[0]
        print("DEFOCUS on", flush=True)
    except Exception as ex3_:
        print("DEFOCUS SKIPPED", repr(ex3_), flush=True)
    tree.links.new(src_out, gl.inputs["Image"])
    tree.links.new(gl.outputs["Image"], ou.inputs[0])
    sc.render.use_compositing = True
except Exception as ex:
    print("POST SKIPPED", repr(ex), flush=True)
    sc.compositing_node_group = None
    sc.render.use_compositing = False
for _o in bpy.data.objects:
    if _o.type == "MESH" and _o.data.materials and _o.data.materials[0] is not None and _o.data.materials[0].name.startswith(("led_", "seam")):
        _o.visible_glossy = False
    if _o.type == "LIGHT" and _o.get("botlight") == 1:
        _o.visible_glossy = False
if PT.ON:
    G = Geo()
    CUR = {}
    # one of each, made at the origin, for the live copies
    with PT.actor("core", pivot=(0, 0, 0)):
        core_unit()
    with PT.actor("sled", pivot=(0, 0, 0)):
        sled_body()
    with PT.actor("sled_straps", pivot=(0, 0, 0)):
        sled_straps()
    with PT.actor("tool_drill", pivot=(0, 0, 0)):
        wrench_unit()
    with PT.actor("slot_ring", pivot=(0, 0, 0)):
        lathe("cell_b", (0, 0, 0), [(0.42, -0.016), (0.47, 0.0), (0.42, 0.016)], seg=32, rx=math.pi / 2)
    with PT.actor("aurora_live", pivot=(0, 0, 0)):
        aurora_sheet()
    for _i, (_x, _z) in enumerate(SLED_CORES):
        PT.spot("sled_core", (_x, -0.325, _z), scale=1.95)
    PT.accents(
        drill=["led_on_orange", "led_dim_orange", "led_hot_orange", "led_on_orange2", "led_dim_orange2", "led_hot_orange2"],
        tow=["led_on_pink", "led_dim_pink", "led_hot_pink"],
    )
    PT.masks(flow=["aurora"], pulse=["lamp", "beacon", "route", "win_warm", "edge_ice"])
    # Each pine bends from its base, on its own beat.
    PT.motion(pine=dict(axis="object", h=1.6, phase="object"))
    # Metals are real metal here, or the live copy goes flat next to the render.
    PT.flat("steel", (0.25, 0.27, 0.3), rough=0.32, metal=1.0)
    PT.flat("tool_steel", (0.4, 0.42, 0.45), rough=0.3, metal=1.0)
    PT.flat("rail", (0.04, 0.044, 0.052), rough=0.38, metal=1.0)
    PT.flat("tower2", (0.026, 0.029, 0.037), rough=0.38, metal=1.0)
    PT.flat("main_trim", (0.04, 0.04, 0.044), rough=0.36, metal=1.0)
    # The render's cores lose light to their coat and to each other. Flat copies need a deeper base to land on the same blue.
    PT.flat("core_a", (0.3, 0.58, 0.72), rough=0.22)
    PT.flat("core_b", (0.09, 0.32, 0.46), rough=0.25)
    PT.flat("core_c", (0.38, 0.26, 0.16), rough=0.35)
    PT.flat("timber", (0.27, 0.13, 0.055), rough=0.7)
    PT.flat("timber2", (0.09, 0.05, 0.03), rough=0.8)
    PT.flat("snow", (0.82, 0.86, 0.93), rough=0.65)
    PT.flat("aurora", (0.0, 0.0, 0.0), rough=1.0, emis=(0.1, 1.0, 0.55), emis_str=1.0)
    # The haze node adds a flat colour over everything, which would land in the accent channels and tint the plate at run time.
    _accent_pass = PT.pass_accent
    def _accent_clean():
        _haze = fg.inputs["B"].default_value[:]
        fg.inputs["B"].default_value = (0, 0, 0, 1)
        _accent_pass()
        fg.inputs["B"].default_value = _haze
    PT.pass_accent = _accent_clean
    PT.finish(co, env_center=Vector((-1.0, 2.0, 2.2)))
    sys.exit(0)
if LOW_BUILD:
    write_forest()
if SAVE:
    bpy.ops.wm.save_as_mainfile(filepath=SAVE)
tris = sum(len(o.data.polygons) for o in bpy.data.objects if o.type == "MESH" and o.name != "pine")
print("unique mesh faces", sum(len(m_.polygons) for m_ in bpy.data.meshes), flush=True)
print("objects", len(bpy.data.objects), "faces (without pine instances)", tris, "pines", len(FOREST), flush=True)
if OPT.get("norender") != "1":
    bpy.ops.render.render(write_still=True)
print("DONE", OUT, flush=True)
