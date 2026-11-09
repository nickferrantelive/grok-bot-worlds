"""Writes assets/mascots/mascots.glb from mascots.py. Plain Python, needs no Blender and no npm.

Run from anywhere: python3 blender/shared/build_mascots_glb.py

Layout of the file:
  one top level node per shape, named shape_<name>, with the body mesh and scale 2
  one child node per shape, named shape_<name>_eyes, origin at the middle of the pair, rotated by the eye lean
  node extras (userData in three.js): shape, height, width, centerUp in units of `size`
  two materials: mascot_body (white, overridable at runtime) and mascot_eye
Positions and normals are 16 bit normalized (KHR_mesh_quantization, no decoder needed in three.js).
Everything is built to size 1, so a sphere is 1 unit across. y is up and the face looks along +z.
"""
import json
import math
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import mascots as M

OUT = os.path.join(HERE, "..", "..", "assets", "mascots", "mascots.glb")
QUANT_RANGE = 2.0    # normalized int16 covers plus or minus this many units, so the node scale is 2
GAP = 1.9            # shapes sit in a row, so the file also reads well in a plain glTF viewer


def triangulate(faces):
    tris = []
    for f in faces:
        for k in range(1, len(f) - 1):
            tris.append((f[0], f[k], f[k + 1]))
    return tris


def normals(V, T):
    N = [[0.0, 0.0, 0.0] for _ in V]
    for a, b, c in T:
        ax, ay, az = V[a]
        ux, uy, uz = V[b][0] - ax, V[b][1] - ay, V[b][2] - az
        vx, vy, vz = V[c][0] - ax, V[c][1] - ay, V[c][2] - az
        nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
        for i in (a, b, c):
            N[i][0] += nx
            N[i][1] += ny
            N[i][2] += nz
    out = []
    for n in N:
        k = math.sqrt(n[0] ** 2 + n[1] ** 2 + n[2] ** 2) or 1.0
        out.append((n[0] / k, n[1] / k, n[2] / k))
    return out


class Writer:
    def __init__(self):
        self.bin = bytearray()
        self.views = []
        self.accessors = []

    def _view(self, data, target, stride=None):
        while len(self.bin) % 4:
            self.bin.append(0)
        v = {"buffer": 0, "byteOffset": len(self.bin), "byteLength": len(data), "target": target}
        if stride:
            v["byteStride"] = stride
        self.bin += data
        self.views.append(v)
        return len(self.views) - 1

    def vec3_i16(self, values, with_minmax):
        data = bytearray()
        ints = []
        for x, y, z in values:
            q = tuple(max(-32767, min(32767, int(round(c * 32767)))) for c in (x, y, z))
            ints.append(q)
            data += struct.pack("<hhhxx", *q)
        acc = {"bufferView": self._view(bytes(data), 34962, 8), "componentType": 5122, "normalized": True, "count": len(values), "type": "VEC3"}
        if with_minmax:
            # The glTF spec stores bounds of a normalized accessor as the raw integers.
            acc["min"] = [min(q[i] for q in ints) for i in range(3)]
            acc["max"] = [max(q[i] for q in ints) for i in range(3)]
        self.accessors.append(acc)
        return len(self.accessors) - 1

    def indices(self, tris):
        data = bytearray()
        for t in tris:
            data += struct.pack("<HHH", *t)
        self.accessors.append({"bufferView": self._view(bytes(data), 34963), "componentType": 5123, "count": len(tris) * 3, "type": "SCALAR"})
        return len(self.accessors) - 1


def main():
    w = Writer()
    meshes, nodes, roots = [], [], []
    report = []
    total_tris = 0
    for si, shape in enumerate(M.SHAPES):
        m = M.mascot_mesh(shape, size=1.0, detail="rt", up="y")
        V, T = m["body_v"], triangulate(m["body_f"])
        if M.face_normals_outward(V, T) <= 0:
            raise RuntimeError("inward winding on " + shape)
        q = [(x / QUANT_RANGE, y / QUANT_RANGE, z / QUANT_RANGE) for x, y, z in V]
        body = {"name": "body_" + shape, "primitives": [{
            "attributes": {"POSITION": w.vec3_i16(q, True), "NORMAL": w.vec3_i16(m["body_n"], False)},
            "indices": w.indices(T), "material": 0}]}
        meshes.append(body)

        # Eyes: mesh origin at the pair middle, x along the pair, y along the eye length
        EV, ET = m["eye_v"], triangulate(m["eye_f"])
        ex, ey, dx, dy, tilt = M.SPEC[shape]["eyes"]
        n_each = len(EV) // 2
        cx = sum(p[0] for p in EV) / len(EV)
        cy = sum(p[1] for p in EV) / len(EV)
        cz = sum(p[2] for p in EV) / len(EV)
        a = math.radians(tilt)
        ca, sa = math.cos(a), math.sin(a)
        local = []
        for x, y, z in EV:
            ux, uy = x - cx, y - cy
            local.append((ux * ca + uy * sa, -ux * sa + uy * ca, z - cz))
        qe = [(x / QUANT_RANGE, y / QUANT_RANGE, z / QUANT_RANGE) for x, y, z in local]
        eyes = {"name": "eyes_" + shape, "primitives": [{
            "attributes": {"POSITION": w.vec3_i16(qe, True), "NORMAL": w.vec3_i16(normals(local, ET), False)},
            "indices": w.indices(ET), "material": 1}]}
        meshes.append(eyes)
        total_tris += len(T) + len(ET)

        eye_node = {
            "name": "shape_%s_eyes" % shape, "mesh": len(meshes) - 1,
            "translation": [cx / QUANT_RANGE, cy / QUANT_RANGE, cz / QUANT_RANGE],
            "rotation": [0.0, 0.0, math.sin(a / 2), math.cos(a / 2)],
        }
        nodes.append(eye_node)
        eye_index = len(nodes) - 1
        nodes.append({
            "name": "shape_" + shape, "mesh": len(meshes) - 2, "children": [eye_index],
            "translation": [(si - (len(M.SHAPES) - 1) / 2) * GAP, 0.0, 0.0],
            "scale": [QUANT_RANGE, QUANT_RANGE, QUANT_RANGE],
            "extras": {"shape": shape, "height": round(m["height"], 4), "width": round(m["width"], 4), "centerUp": round(m["center_up"], 4),
                       "eyeCenter": [round(cx, 4), round(cy, 4), round(cz, 4)], "color": M.PALETTE[shape]},
        })
        roots.append(len(nodes) - 1)
        report.append("%-9s h %.3f w %.3f tris %d" % (shape, m["height"], m["width"], len(T) + len(ET)))

    g = M.GLOSSY_REALTIME
    doc = {
        "asset": {"version": "2.0", "generator": "grok-islands build_mascots_glb.py"},
        "extensionsUsed": ["KHR_mesh_quantization", "KHR_materials_clearcoat"],
        "extensionsRequired": ["KHR_mesh_quantization"],
        "scene": 0,
        "scenes": [{"name": "mascots", "nodes": roots}],
        "nodes": nodes,
        "meshes": meshes,
        "materials": [
            {"name": "mascot_body",
             "pbrMetallicRoughness": {"baseColorFactor": [1, 1, 1, 1], "metallicFactor": 0.0, "roughnessFactor": g["roughness"]},
             "extensions": {"KHR_materials_clearcoat": {"clearcoatFactor": g["clearcoat"], "clearcoatRoughnessFactor": g["clearcoatRoughness"]}}},
            {"name": "mascot_eye",
             "pbrMetallicRoughness": {"baseColorFactor": [0.006, 0.006, 0.009, 1], "metallicFactor": 0.0, "roughnessFactor": 0.62}},
        ],
        "accessors": w.accessors,
        "bufferViews": w.views,
        "buffers": [{"byteLength": len(w.bin)}],
    }
    while len(w.bin) % 4:
        w.bin.append(0)
    doc["buffers"][0]["byteLength"] = len(w.bin)
    js = json.dumps(doc, separators=(",", ":")).encode("utf8")
    js += b" " * ((4 - len(js) % 4) % 4)
    total = 12 + 8 + len(js) + 8 + len(w.bin)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, total))
        f.write(struct.pack("<II", len(js), 0x4E4F534A))
        f.write(js)
        f.write(struct.pack("<II", len(w.bin), 0x004E4942))
        f.write(bytes(w.bin))
    print("\n".join(report))
    print("wrote %s, %.1f KB, %d triangles in total" % (os.path.normpath(OUT), total / 1024, total_tris))


if __name__ == "__main__":
    main()
