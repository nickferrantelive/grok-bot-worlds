"""The grok bot mascot family as plain geometry. No bpy, no numpy, only the standard library.

Every body is the user's silhouette inflated like a balloon: solve a Poisson problem over the
outline, take the square root, and a circle comes out as an exact sphere while a star comes out
as a soft pillow with round arms. Rings run parallel to the outline, so a low vertex count still
gives a clean edge and clean highlights.

Import it from a look script:

    import os, sys
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "shared"))
    import mascots

    m = mascots.placed_mesh("star", size=0.82, base=(x, y, z), facing=a, pitch=math.radians(-8))
    G.add("bot", m["body_v"], m["body_f"], [True] * len(m["body_f"]))
    G.add("eye", m["eye_v"], m["eye_f"], [True] * len(m["eye_f"]))

Conventions: `size` is the diameter of a circle with the same area as the body, so the family has
equal visual mass. Blender axes: X right, Z up, the face looks along -Y. The origin of a mesh is
on the ground under the body, so a base point can be passed straight through.
"""
import bisect
import math

SHAPES = ("sphere", "cloud", "triangle", "star", "star4", "squircle", "pentagon", "drop", "hexagon", "capsule")

# sRGB colours sampled from the user's art. The lead is always the white sphere.
PALETTE = {
    "lead": "#f2f3f7",
    "sphere": "#f6a01e",
    "cloud": "#f53a9e",
    "triangle": "#43cf8f",
    "star": "#fb7f16",
    "star4": "#f46510",
    "squircle": "#fba42a",
    "pentagon": "#2f74ee",
    "drop": "#8a56ea",
    "hexagon": "#17b8a3",
    "capsule": "#f4323f",
    "cloud_red": "#f4403f",
    "cloud_teal": "#49cdb6",
    "grey": "#7a7a7e",
    "brown": "#9f6b39",
}

# Recommended Cycles material for the body. Pass these to a Principled BSDF, Base Color is
# linear, so use srgb_to_linear(PALETTE[...]). `sss_scale` is a multiple of the bot size.
GLOSSY = dict(roughness=0.3, coat=1.0, coat_roughness=0.06, sss=0.42, sss_scale=0.09, specular=0.5)
EYE_MATERIAL = dict(base=(0.006, 0.006, 0.009), roughness=0.3, coat=0.6, coat_roughness=0.12)
# The same two looks as three.js MeshPhysicalMaterial parameters, already in mascots.glb.
GLOSSY_REALTIME = dict(roughness=0.34, clearcoat=1.0, clearcoatRoughness=0.15)

DETAIL = {
    # rim segments, rings from the rim to the middle of one side, eye segments, eye rings
    "film": dict(n=240, m=26, en=44, em=6),
    "rt": dict(n=60, m=7, en=22, em=3),
    "far": dict(n=30, m=3, en=10, em=1),
}

_BASE_N = 720        # samples on the master outline
_SOLVE_N = 120       # outline samples used by the Poisson solve, a divisor of _BASE_N
_SOLVE_M = 14        # rings used by the Poisson solve


def srgb_to_linear(hex_color):
    """'#rrggbb' to a linear (r, g, b) tuple."""
    h = hex_color.lstrip("#")
    out = []
    for i in (0, 2, 4):
        c = int(h[i:i + 2], 16) / 255.0
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return tuple(out)


# ---------- outlines ----------
def _rot2(p, deg):
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    return [(x * c - y * s, x * s + y * c) for x, y in p]


def _poly(pts, bulge=0.0):
    """Closed polyline through `pts`. bulge > 0 bows every edge outward by that fraction of its length."""
    out = []
    n = len(pts)
    area = sum(pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1] for i in range(n))
    side = 1.0 if area > 0 else -1.0
    for i in range(n):
        a, b = pts[i], pts[(i + 1) % n]
        dx, dy = b[0] - a[0], b[1] - a[1]
        for k in range(40):
            t = k / 40.0
            s = bulge * 4.0 * t * (1.0 - t)
            out.append((a[0] + dx * t + dy * s * side, a[1] + dy * t - dx * s * side))
    return out


def _hull2(c1, r1, c2, r2, n=360):
    """Convex hull of two circles: a capsule when the radii match, a drop when c2 is a small tip."""
    dx, dy = c2[0] - c1[0], c2[1] - c1[1]
    d = math.hypot(dx, dy)
    phi = math.atan2(dy, dx)
    alpha = math.acos(max(-1.0, min(1.0, (r1 - r2) / d)))
    out = []
    n2 = max(8, int(n * alpha / math.pi / 2))
    for k in range(n2 + 1):
        t = phi - alpha + 2 * alpha * k / n2
        out.append((c2[0] + r2 * math.cos(t), c2[1] + r2 * math.sin(t)))
    n1 = n
    span = 2 * math.pi - 2 * alpha
    for k in range(n1 + 1):
        t = phi + alpha + span * k / n1
        out.append((c1[0] + r1 * math.cos(t), c1[1] + r1 * math.sin(t)))
    return out


def _circles(circles, n=1440):
    """Outer boundary of a union of circles, by rays from their mean centre."""
    cx = sum(c[0] for c in circles) / len(circles)
    cy = sum(c[1] for c in circles) / len(circles)
    out = []
    for k in range(n):
        t = 2 * math.pi * k / n
        dx, dy = math.cos(t), math.sin(t)
        best = 0.0
        for x, y, r in circles:
            ox, oy = cx - x, cy - y
            b = ox * dx + oy * dy
            q = b * b - (ox * ox + oy * oy - r * r)
            if q >= 0:
                best = max(best, -b + math.sqrt(q))
        out.append((cx + dx * best, cy + dy * best))
    return out


def _arms(core, arms, n=1440):
    """Outer boundary of a plump star: a core disc plus tapered round arms, by rays from the middle."""
    hulls = []
    for ang, length, tip in arms:
        a = math.radians(ang)
        hulls.append(_hull2((0.0, 0.0), core, (length * math.cos(a), length * math.sin(a)), tip, n=48))
    out = []
    for k in range(n):
        t = 2 * math.pi * k / n
        dx, dy = math.cos(t), math.sin(t)
        best = core
        for h in hulls:
            m = len(h)
            for i in range(m):
                ax, ay = h[i]
                bx, by = h[(i + 1) % m]
                ex, ey = bx - ax, by - ay
                d = dx * ey - dy * ex
                if abs(d) < 1e-12:
                    continue
                u = (ax * ey - ay * ex) / d
                v = (ax * dy - ay * dx) / d
                if 0.0 <= v <= 1.0 and u > best:
                    best = u
        out.append((dx * best, dy * best))
    return out


def _resample(p, n):
    """Closed polyline to n points, uniform by arc length."""
    L = [0.0]
    m = len(p)
    for i in range(m):
        a, b = p[i], p[(i + 1) % m]
        L.append(L[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
    total = L[-1]
    out = []
    j = 0
    for k in range(n):
        s = total * k / n
        while j < m - 1 and L[j + 1] < s:
            j += 1
        a, b = p[j], p[(j + 1) % m]
        seg = max(L[j + 1] - L[j], 1e-12)
        t = (s - L[j]) / seg
        out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    return out


def _gauss(p, sigma):
    """Circular Gaussian low pass, sigma as a fraction of the perimeter. Rounds corners with continuous curvature."""
    n = len(p)
    sig = max(sigma * n, 1e-6)
    half = int(3.0 * sig) + 1
    w = [math.exp(-0.5 * (k / sig) ** 2) for k in range(-half, half + 1)]
    tot = sum(w)
    xs = [q[0] for q in p]
    ys = [q[1] for q in p]
    out = []
    for i in range(n):
        sx = sy = 0.0
        for k, wk in enumerate(w):
            q = (i + k - half) % n
            sx += xs[q] * wk
            sy += ys[q] * wk
        out.append((sx / tot, sy / tot))
    return out


def _normalize(p):
    """Move the area centroid to the origin and scale to area pi, so the equal area radius is 1."""
    a = cx = cy = 0.0
    n = len(p)
    for i in range(n):
        x0, y0 = p[i]
        x1, y1 = p[(i + 1) % n]
        c = x0 * y1 - x1 * y0
        a += c
        cx += (x0 + x1) * c
        cy += (y0 + y1) * c
    a *= 0.5
    cx /= 6.0 * a
    cy /= 6.0 * a
    k = math.sqrt(math.pi / abs(a))
    q = [((x - cx) * k, (y - cy) * k) for x, y in p]
    if a < 0:
        q.reverse()
    return q


# Each spec is fitted to the user's art. `eyes` is (x, y, dx, dy, tilt): the middle of the pair in
# equal area radii, the vector from the left eye to the right eye, and how far the eyes lean left.
SPEC = {
    "sphere": dict(kind="circle", puff=1.0, eyes=(0.27, 0.40, 0.47, 0.17, 26.0)),
    "cloud": dict(
        kind="circles", soft=0.006, puff=0.8,
        circles=[(-0.39, 0.3, 0.8), (0.32, 0.6, 0.46), (0.79, 0.06, 0.5), (-0.74, -0.47, 0.54), (-0.08, -0.54, 0.54), (0.46, -0.36, 0.56), (0.05, -0.03, 0.72)],
        eyes=(0.34, 0.32, 0.44, 0.12, 25.0)),
    "triangle": dict(
        kind="poly", soft=0.03, bulge=0.1074, puff=0.74,
        pts=[(-0.699, 1.704), (1.93, -0.105), (-0.826, -1.684)],
        eyes=(0.38, 0.28, 0.46, 0.13, 18.0)),
    "star": dict(
        kind="arms", core=0.76, soft=0.015, puff=0.68,
        arms=[(66.3, 1.42, 0.4), (-6.0, 1.4, 0.4), (-82.0, 1.26, 0.4), (-154.0, 1.3, 0.4), (142.3, 1.3, 0.4)],
        eyes=(0.05, 0.02, 0.50, 0.03, 6.0)),
    "star4": dict(
        kind="poly", soft=0.0241, bulge=0.12, puff=0.66,
        pts=[(-0.56, 0.561), (-1.259, -0.148), (-0.4, -0.55), (0.205, -1.353), (0.747, -0.487), (1.432, 0.137), (0.551, 0.597), (-0.041, 1.371)],
        eyes=(0.18, 0.20, 0.43, 0.12, 26.0)),
    "squircle": dict(
        kind="poly", soft=0.0416, bulge=0.0944, puff=0.74,
        pts=[(-1.473, 0.581), (0.701, 1.435), (1.812, -0.806), (-0.349, -1.578)],
        eyes=(0.16, 0.02, 0.44, 0.12, 25.0)),
    "pentagon": dict(
        kind="poly", soft=0.023, bulge=0.012, puff=0.72,
        pts=[(0.064, 1.178), (1.212, 0.321), (1.047, -1.174), (-0.759, -1.28), (-0.987, 0.37)],
        eyes=(0.10, 0.10, 0.40, 0.02, 3.0)),
    "drop": dict(
        kind="hull", c1=(-0.126, 0.011), r1=1.239, c2=(-0.559, 1.388), r2=0.248, soft=0.0201, bend=-0.011, puff=0.84,
        eyes=(0.40, 0.30, 0.42, 0.12, 25.0)),
    "hexagon": dict(
        kind="poly", soft=0.0142, bulge=0.0142, puff=0.72,
        pts=[(-1.333, 0.142), (-0.487, 1.17), (0.697, 0.867), (1.239, -0.256), (0.401, -1.281), (-0.781, -0.991)],
        eyes=(0.21, 0.06, 0.56, 0.15, 27.0)),
    "capsule": dict(
        kind="hull", c1=(-0.09, -0.28), r1=0.861, c2=(0.677, -0.076), r2=0.862, soft=0.0057, bend=-0.0064, puff=0.72,
        eyes=(0.32, 0.32, 0.58, 0.16, 26.0)),
}

EYE_LEN = 0.54       # eye length in equal area radii. Flat art .46, glossy art .55. Holds at 50 px.
EYE_WID = 0.225
EYE_LIFT = 0.032
EYE_RIM = 0.006


def build_outline(spec):
    """Unit outline (area pi, centroid at the origin, counter clockwise) from one spec entry."""
    kind = spec["kind"]
    if kind == "circle":
        p = [(math.cos(2 * math.pi * k / _BASE_N), math.sin(2 * math.pi * k / _BASE_N)) for k in range(_BASE_N)]
        return _normalize(p)
    if kind == "poly":
        raw = _poly(spec["pts"], spec.get("bulge", 0.0))
    elif kind == "star":
        pts = []
        n = spec["arms"]
        for i in range(2 * n):
            t = math.radians(spec["rot"]) - math.pi * i / n
            r = spec["tip"] if i % 2 == 0 else spec["inner"]
            if isinstance(r, (list, tuple)):
                r = r[(i // 2) % n]
            pts.append((r * math.cos(t), r * math.sin(t)))
        pts.reverse()
        raw = _poly(pts)
    elif kind == "circles":
        raw = _circles(spec["circles"])
    elif kind == "arms":
        raw = _arms(spec["core"], spec["arms"])
    elif kind == "hull":
        raw = _hull2(spec["c1"], spec["r1"], spec["c2"], spec["r2"])
        if spec.get("bend"):
            b = spec["bend"]
            raw = [(x + b * max(0.0, y) ** 2, y) for x, y in raw]
    else:
        raise ValueError(kind)
    p = _resample(raw, _BASE_N)
    p = _gauss(p, spec.get("soft", 0.01))
    return _normalize(_resample(p, _BASE_N))


def _is_star_convex(p):
    last = math.atan2(p[0][1], p[0][0])
    total = 0.0
    for x, y in p[1:] + p[:1]:
        t = math.atan2(y, x)
        d = (t - last + math.pi) % (2 * math.pi) - math.pi
        if d <= 0:
            return False
        total += d
        last = t
    return abs(total - 2 * math.pi) < 1e-6


# ---------- inflate ----------
def _rings(m):
    """Ring radii from the middle (0) to the rim (1). The rim gets the most rings, as sin of a uniform angle."""
    return [math.sin(0.5 * math.pi * j / m) for j in range(m + 1)]


def _solve_field(outline):
    """FEM Poisson solve on the ring mesh. Returns G[i][j] = u / (1 - rho^2), smooth right up to the rim."""
    N, M = _SOLVE_N, _SOLVE_M
    step = _BASE_N // N
    B = outline[::step]
    rho = _rings(M)
    def pos(i, j):
        return (B[i % N][0] * rho[j], B[i % N][1] * rho[j])
    def idx(i, j):
        if j == 0:
            return 0
        if j == M:
            return -1
        return 1 + (j - 1) * N + (i % N)
    count = 1 + (M - 1) * N
    rows = [{} for _ in range(count)]
    diag = [0.0] * count
    load = [0.0] * count
    def tri(a, b, c):
        pa, pb, pc = pos(*a), pos(*b), pos(*c)
        ia, ib, ic = idx(*a), idx(*b), idx(*c)
        area2 = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pc[0] - pa[0]) * (pb[1] - pa[1])
        if abs(area2) < 1e-12:
            return
        def cot(o, p, q):
            ux, uy = p[0] - o[0], p[1] - o[1]
            vx, vy = q[0] - o[0], q[1] - o[1]
            return (ux * vx + uy * vy) / abs(ux * vy - uy * vx)
        ca, cb, cc = cot(pa, pb, pc), cot(pb, pc, pa), cot(pc, pa, pb)
        for (u, v, w) in ((ib, ic, ca), (ic, ia, cb), (ia, ib, cc)):
            w *= 0.5
            if u >= 0:
                diag[u] += w
            if v >= 0:
                diag[v] += w
            if u >= 0 and v >= 0:
                rows[u][v] = rows[u].get(v, 0.0) - w
                rows[v][u] = rows[v].get(u, 0.0) - w
        f = abs(area2) / 6.0
        for u in (ia, ib, ic):
            if u >= 0:
                load[u] += f
    for i in range(N):
        tri((i, 0), (i, 1), (i + 1, 1))
        for j in range(1, M):
            tri((i, j), (i, j + 1), (i + 1, j + 1))
            tri((i, j), (i + 1, j + 1), (i + 1, j))
    # Conjugate gradients with a Jacobi preconditioner
    R = [list(r.items()) for r in rows]
    x = [0.0] * count
    r = load[:]
    z = [r[k] / diag[k] for k in range(count)]
    p = z[:]
    rz = sum(a * b for a, b in zip(r, z))
    goal = rz * 1e-14
    for _ in range(900):
        Ap = [diag[k] * p[k] + sum(w * p[q] for q, w in R[k]) for k in range(count)]
        d = sum(a * b for a, b in zip(p, Ap))
        if d <= 0:
            break
        a = rz / d
        for k in range(count):
            x[k] += a * p[k]
            r[k] -= a * Ap[k]
        z = [r[k] / diag[k] for k in range(count)]
        rz2 = sum(c * e for c, e in zip(r, z))
        if rz2 < goal:
            break
        b = rz2 / rz
        rz = rz2
        p = [z[k] + b * p[k] for k in range(count)]
    G = []
    for i in range(N):
        col = [x[0]]
        for j in range(1, M):
            col.append(x[idx(i, j)] / (1.0 - rho[j] ** 2))
        col.append(max(1e-5, 2.0 * col[M - 1] - col[M - 2]))
        G.append(col)
    return G


def _catmull(a, b, c, d, t):
    return 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (3 * b - a - 3 * c + d) * t * t * t)


class _Body:
    """One inflated body in unit size (equal area radius 1), front half thickness = puff."""

    def __init__(self, shape):
        spec = SPEC[shape]
        self.shape = shape
        self.spec = spec
        self.outline = build_outline(spec)
        self.analytic = spec["kind"] == "circle"
        self.G = None if self.analytic else _solve_field(self.outline)
        self.rho_solve = _rings(_SOLVE_M)
        self.kmax = 1.0
        if not self.analytic:
            best = 0.0
            for col in self.G:
                for j, r in enumerate(self.rho_solve):
                    best = max(best, col[j] * (1.0 - r * r))
            self.kmax = best
        self.angles = [math.atan2(y, x) for x, y in self.outline]
        s = min(range(_BASE_N), key=lambda k: self.angles[k])
        self.order = [(k + s) % _BASE_N for k in range(_BASE_N)]
        self.sorted_angles = [self.angles[k] for k in self.order]
        self.star_convex = _is_star_convex(self.outline)

    def field(self, s, rho):
        """s is a fractional index along the master outline, rho in [0, 1]."""
        if self.analytic:
            return 1.0
        f = (s / (_BASE_N / _SOLVE_N)) % _SOLVE_N
        i = int(f)
        t = f - i
        lo = bisect.bisect_right(self.rho_solve, rho) - 1
        lo = max(0, min(_SOLVE_M - 1, lo))
        v = (rho - self.rho_solve[lo]) / (self.rho_solve[lo + 1] - self.rho_solve[lo])
        vals = []
        for q in (-1, 0, 1, 2):
            col = self.G[(i + q) % _SOLVE_N]
            vals.append(col[lo] + (col[lo + 1] - col[lo]) * v)
        return max(0.0, _catmull(vals[0], vals[1], vals[2], vals[3], t))

    def height(self, s, rho):
        """Half thickness of the body at this outline position and ring radius."""
        q = max(0.0, 1.0 - rho * rho)
        if self.analytic:
            return math.sqrt(q)
        return self.spec["puff"] * math.sqrt(max(0.0, self.field(s, rho) * q / self.kmax))

    def at(self, s):
        k = s % _BASE_N
        i = int(k)
        t = k - i
        a, b = self.outline[i], self.outline[(i + 1) % _BASE_N]
        return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)

    def locate(self, x, y):
        """Plane point to (s, rho). The outline is star convex about the origin, so the ray meets it once."""
        t = math.atan2(y, x)
        k = bisect.bisect_right(self.sorted_angles, t) - 1
        i0 = self.order[k % _BASE_N]
        i1 = (i0 + 1) % _BASE_N
        a0, a1 = self.angles[i0], self.angles[i1]
        span = (a1 - a0) % (2 * math.pi)
        f = ((t - a0) % (2 * math.pi)) / span if span > 0 else 0.0
        s = i0 + min(1.0, f)
        px, py = self.at(s)
        R = math.hypot(px, py)
        return s, min(1.0, math.hypot(x, y) / max(R, 1e-9))

    def surface(self, x, y):
        s, rho = self.locate(x, y)
        return self.height(s, rho)

    def sample_params(self, n):
        """n fractional outline indices, denser where the outline bends hard."""
        p = self.outline
        N = _BASE_N
        dens = []
        w = 5
        for i in range(N):
            ax, ay = p[(i - w) % N]
            bx, by = p[i]
            cx, cy = p[(i + w) % N]
            u = math.atan2(by - ay, bx - ax)
            v = math.atan2(cy - by, cx - bx)
            d = abs((v - u + math.pi) % (2 * math.pi) - math.pi)
            dens.append(1.0 + 7.0 * d)
        cum = [0.0]
        for d in dens:
            cum.append(cum[-1] + d)
        total = cum[-1]
        out = []
        for k in range(n):
            g = total * k / n
            j = bisect.bisect_right(cum, g) - 1
            j = min(j, N - 1)
            out.append(j + (g - cum[j]) / max(cum[j + 1] - cum[j], 1e-12))
        return out


_BODIES = {}
_MESHES = {}


def _body(shape):
    if shape not in SPEC:
        raise ValueError("unknown mascot shape %r, have %s" % (shape, ", ".join(SHAPES)))
    if shape not in _BODIES:
        _BODIES[shape] = _Body(shape)
    return _BODIES[shape]


def _unit_mesh(shape, detail):
    """Unit body and eyes in art axes: x right, y up, z towards the viewer."""
    key = (shape, detail)
    if key in _MESHES:
        return _MESHES[key]
    b = _body(shape)
    d = DETAIL[detail]
    n, m = d["n"], d["m"]
    params = b.sample_params(n)
    rho = _rings(m)
    V = [(0.0, 0.0, b.height(0.0, 0.0))]
    # front rings from the middle out, then the rim, then the back from the rim to the middle
    for j in range(1, m + 1):
        for s in params:
            x, y = b.at(s)
            V.append((x * rho[j], y * rho[j], b.height(s, rho[j]) if j < m else 0.0))
    for j in range(m - 1, 0, -1):
        for s in params:
            x, y = b.at(s)
            V.append((x * rho[j], y * rho[j], -b.height(s, rho[j])))
    V.append((0.0, 0.0, -b.height(0.0, 0.0)))
    F = []
    last = len(V) - 1
    def ring(r, i):
        return 1 + (r - 1) * n + (i % n)
    for i in range(n):
        F.append((0, ring(1, i), ring(1, i + 1)))
    total_rings = 2 * m - 1
    for r in range(1, total_rings):
        for i in range(n):
            F.append((ring(r, i), ring(r + 1, i), ring(r + 1, i + 1), ring(r, i + 1)))
    for i in range(n):
        F.append((last, ring(total_rings, i + 1), ring(total_rings, i)))

    # Eyes: two stadium domes that follow the surface they sit on
    ex, ey, dx, dy, tilt = b.spec["eyes"]
    EV, EF = [], []
    en, em = d["en"], d["em"]
    half = EYE_LEN * 0.5
    r0 = EYE_WID * 0.5
    a = math.radians(tilt)
    ca, sa = math.cos(a), math.sin(a)
    # stadium outline with even spacing
    straight = max(half - r0, 0.0)
    per = 4 * straight + 2 * math.pi * r0
    stad = []
    for k in range(en):
        g = per * k / en
        if g < 2 * straight:
            stad.append((r0, -straight + g))
        elif g < 2 * straight + math.pi * r0:
            t = (g - 2 * straight) / r0
            stad.append((r0 * math.cos(t), straight + r0 * math.sin(t)))
        elif g < 4 * straight + math.pi * r0:
            stad.append((-r0, straight - (g - 2 * straight - math.pi * r0)))
        else:
            t = (g - 4 * straight - math.pi * r0) / r0 + math.pi
            stad.append((r0 * math.cos(t), -straight + r0 * math.sin(t)))
    for side in (-0.5, 0.5):
        cx, cy = ex + side * dx, ey + side * dy
        base = len(EV)
        def place_eye(u, w, lift):
            x = cx + u * ca - w * sa
            y = cy + u * sa + w * ca
            return (x, y, b.surface(x, y) + lift)
        EV.append(place_eye(0.0, 0.0, EYE_LIFT))
        for j in range(1, em + 1):
            t = math.sin(0.5 * math.pi * j / em)
            lift = EYE_RIM + (EYE_LIFT - EYE_RIM) * math.sqrt(max(0.0, 1.0 - t * t))
            for u, w in stad:
                EV.append(place_eye(u * t, w * t, lift))
        # a skirt below the surface: the outline is this clean rim, not wherever the dome cuts the body
        for u, w in stad:
            EV.append(place_eye(u, w, -0.05))
        def eye_ring(r, i):
            return base + 1 + (r - 1) * en + (i % en)
        for i in range(en):
            EF.append((base, eye_ring(1, i), eye_ring(1, i + 1)))
        for r in range(1, em + 1):
            for i in range(en):
                EF.append((eye_ring(r, i), eye_ring(r + 1, i), eye_ring(r + 1, i + 1), eye_ring(r, i + 1)))
    # Normals from the true surface rather than the coarse mesh, so low poly highlights stay smooth.
    def point(s, p):
        r = math.sin(p)
        x, y = b.at(s)
        return (x * r, y * r, b.height(s, r))
    def surf_normal(s, p):
        ds, dp = 1.2, 0.012
        a0, a1 = point(s - ds, p), point(s + ds, p)
        p0, p1 = max(p - dp, 0.0), min(p + dp, 0.5 * math.pi)
        c0, c1 = point(s, p0), point(s, p1)
        ux, uy, uz = a1[0] - a0[0], a1[1] - a0[1], a1[2] - a0[2]
        vx, vy, vz = c1[0] - c0[0], c1[1] - c0[1], c1[2] - c0[2]
        nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
        L = math.sqrt(nx * nx + ny * ny + nz * nz) or 1.0
        nx, ny, nz = nx / L, ny / L, nz / L
        # outward: away from the centre of the body
        if nx * (a0[0] + c1[0]) + ny * (a0[1] + c1[1]) + nz * (a0[2] + c1[2]) < 0:
            nx, ny, nz = -nx, -ny, -nz
        return (nx, ny, nz)
    NR = [(0.0, 0.0, 1.0)]
    for j in range(1, m + 1):
        p = 0.5 * math.pi * j / m
        for s in params:
            n3 = surf_normal(s, p)
            NR.append((n3[0], n3[1], 0.0 if j == m else n3[2]))
    for j in range(m - 1, 0, -1):
        p = 0.5 * math.pi * j / m
        for s in params:
            n3 = surf_normal(s, p)
            NR.append((n3[0], n3[1], -n3[2]))
    NR.append((0.0, 0.0, -1.0))
    bottom = min(v[1] for v in V)
    _MESHES[key] = dict(V=V, F=F, N=NR, EV=EV, EF=EF, bottom=bottom, top=max(v[1] for v in V),
                        left=min(v[0] for v in V), right=max(v[0] for v in V))
    return _MESHES[key]


def mascot_mesh(shape, size=1.0, detail="film", up="z", lean=0.0):
    """Return one bot, base on the ground, centred on its area centroid.

    shape  one of SHAPES
    size   diameter of a circle of the same area
    detail "film" (about 12k quads, for Cycles), "rt" (about 1.6k triangles), "far"
    up     "z" for Blender axes (face along -Y), "y" for glTF and three.js axes (face along +Z)
    lean   extra rotation in degrees, counter clockwise from the front. The art lean is already built in.

    Returns a dict with body_v, body_f, eye_v, eye_f (lists of tuples), plus height, width and
    center_up, the height of the area centroid above the ground.
    """
    u = _unit_mesh(shape, detail)
    r = size * 0.5
    c, s = math.cos(math.radians(lean)), math.sin(math.radians(lean))
    def turn(p):
        return (p[0] * c - p[1] * s, p[0] * s + p[1] * c, p[2])
    V = [turn(p) for p in u["V"]]
    E = [turn(p) for p in u["EV"]]
    bottom = min(p[1] for p in V)
    top = max(p[1] for p in V)
    def conv(p):
        x, y, z = p[0] * r, (p[1] - bottom) * r, p[2] * r
        return (x, -z, y) if up == "z" else (x, y, z)
    def conv_n(p):
        x, y, z = turn(p)
        return (x, -z, y) if up == "z" else (x, y, z)
    width = (max(p[0] for p in V) - min(p[0] for p in V)) * r
    # Art axes and both output axes are right handed, so the winding holds. Fan and quad order are outward.
    return dict(
        body_v=[conv(p) for p in V], body_f=list(u["F"]), body_n=[conv_n(n) for n in u["N"]],
        eye_v=[conv(p) for p in E], eye_f=list(u["EF"]),
        height=(top - bottom) * r, width=width, center_up=-bottom * r,
    )


def placed_mesh(shape, size=1.0, base=(0.0, 0.0, 0.0), facing=0.0, pitch=0.0, detail="film", lean=0.0):
    """Blender axes, moved to `base` (the ground point under the bot).

    facing turns about Z (radians), the same sense as the interim bot(): atan2(dx, -dy) faces the
    point (dx, dy) away. pitch below zero tips the face up, about -8 degrees suits a camera above.
    """
    m = mascot_mesh(shape, size=size, detail=detail, up="z", lean=lean)
    cf, sf = math.cos(facing), math.sin(facing)
    cp, sp = math.cos(pitch), math.sin(pitch)
    pivot = m["center_up"]
    def go(p):
        x, y, z = p[0], p[1], p[2] - pivot
        y, z = y * cp - z * sp, y * sp + z * cp
        x, y = x * cf - y * sf, x * sf + y * cf
        return (x + base[0], y + base[1], z + pivot + base[2])
    m["body_v"] = [go(p) for p in m["body_v"]]
    m["eye_v"] = [go(p) for p in m["eye_v"]]
    return m


# ---------- the floating job tools ----------
# Glossy toys from the same art as the bots. Everything is modelled in units of the bot size, in
# art axes (x right, y up, z towards the viewer). Colours are fixed by default, because the art
# gives each tool its own. `accent_mat` in placed_prop hands the accent part to a bot's material.
PROPS = ("magnifier", "megaphone", "camera", "funnel", "magnet", "chart", "calendar", "wrench")

_TOY = dict(metal=0.0, roughness=0.3, coat=1.0, coat_roughness=0.07, sss=0.3, sss_scale=0.05)
# `color` is sRGB, use srgb_to_linear. `sss_scale` is a multiple of the bot size, as in GLOSSY.
PROP_MATERIALS = {
    "prop_white": dict(_TOY, color="#f3f2ef"),
    "prop_grey": dict(_TOY, color="#c3c6cc", roughness=0.42, coat=0.5, sss=0.0),
    "prop_dark": dict(_TOY, color="#16171c", roughness=0.2, sss=0.0),
    "prop_glass": dict(_TOY, color="#b4e6d2", roughness=0.1, coat_roughness=0.03, sss=0.0),
    "prop_steel": dict(_TOY, color="#bfc4cc", metal=0.45, roughness=0.26, sss=0.0),
    "prop_red": dict(_TOY, color="#ec2f33"),
    "prop_green": dict(_TOY, color="#35c866"),
    "prop_orange": dict(_TOY, color="#fb7f16"),
}


def prop_base(mat):
    """Linear base colour of a prop material. AgX pulls strong colour towards pastel, so saturated
    colours are pushed a little past the art, the same way the lineup pushes the bots."""
    r, g, b = srgb_to_linear(PROP_MATERIALS[mat]["color"])
    top, low = max(r, g, b, 1e-4), min(r, g, b)
    if top - low < 0.04:
        return (r, g, b)
    return tuple(top * (v / top) ** 1.28 for v in (r, g, b))


def prop_materials(pbsdf, size=1.0):
    """All prop materials through an island script's own pbsdf helper, keyed for MATS.update()."""
    out = {}
    for key, m in PROP_MATERIALS.items():
        out[key] = pbsdf(key, base=prop_base(key), rough=m["roughness"], metal=m["metal"], coat=m["coat"],
                         coat_rough=m["coat_roughness"], sss=m["sss"], sss_scale=m["sss_scale"] * size)
    return out


_PROP_DETAIL = {
    "film": dict(seg=56, sides=18, arc=64, n=4, caps=5, fil=4),
    "rt": dict(seg=20, sides=8, arc=20, n=1, caps=2, fil=2),
    "far": dict(seg=12, sides=6, arc=12, n=1, caps=1, fil=1),
}


def _closed(V, F):
    """Faces wind outward, whatever order the primitive built them in."""
    if face_normals_outward(V, F) < 0:
        F = [tuple(reversed(f)) for f in F]
    return V, F


def _fillet(pts, r=0.012, n=4):
    """Round the inner corners of an open polyline with quadratic curves."""
    out = [pts[0]]
    for i in range(1, len(pts) - 1):
        p0, p1, p2 = pts[i - 1], pts[i], pts[i + 1]
        d1 = math.hypot(p0[0] - p1[0], p0[1] - p1[1])
        d2 = math.hypot(p2[0] - p1[0], p2[1] - p1[1])
        d = min(r, 0.45 * d1, 0.45 * d2)
        a = (p1[0] + (p0[0] - p1[0]) * d / d1, p1[1] + (p0[1] - p1[1]) * d / d1)
        b = (p1[0] + (p2[0] - p1[0]) * d / d2, p1[1] + (p2[1] - p1[1]) * d / d2)
        for k in range(n + 1):
            t = k / n
            out.append(((1 - t) ** 2 * a[0] + 2 * (1 - t) * t * p1[0] + t * t * b[0],
                        (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * p1[1] + t * t * b[1]))
    out.append(pts[-1])
    return out


def _lathe(profile, seg):
    """Solid of revolution about +z. The profile runs (r, h) from the axis, around, back to the axis."""
    V, F = [(0.0, 0.0, profile[0][1])], []
    inner = profile[1:-1]
    for r, h in inner:
        for i in range(seg):
            a = 2 * math.pi * i / seg
            V.append((r * math.cos(a), r * math.sin(a), h))
    V.append((0.0, 0.0, profile[-1][1]))
    last = len(V) - 1
    def at(j, i):
        return 1 + j * seg + (i % seg)
    for i in range(seg):
        F.append((0, at(0, i), at(0, i + 1)))
        F.append((last, at(len(inner) - 1, i + 1), at(len(inner) - 1, i)))
    for j in range(len(inner) - 1):
        for i in range(seg):
            F.append((at(j, i), at(j + 1, i), at(j + 1, i + 1), at(j, i + 1)))
    return _closed(V, F)


def _ball(r, d):
    n = max(6, d["seg"] // 4)
    return _lathe([(r * math.sin(math.pi * k / n), -r * math.cos(math.pi * k / n)) for k in range(n + 1)], d["seg"])


def _arc(cx, cy, R, a0, a1, n):
    return [(cx + R * math.cos(math.radians(a0 + (a1 - a0) * k / n)), cy + R * math.sin(math.radians(a0 + (a1 - a0) * k / n))) for k in range(n + 1)]


def _tube(path, rx, rz, d, closed=False, e=2.0):
    """Sweep a round (e = 2) or squarish (e > 2) section along a path in the xy plane, with round ends."""
    pts = path[:-1] if closed else path
    n = len(pts)
    sides = d["sides"]
    def section(p, nx, ny, k, shift=(0.0, 0.0)):
        ring = []
        for i in range(sides):
            a = 2 * math.pi * i / sides
            ca, sa = math.cos(a), math.sin(a)
            u = math.copysign(abs(ca) ** (2.0 / e), ca) * rx * k
            w = math.copysign(abs(sa) ** (2.0 / e), sa) * rz * k
            ring.append((p[0] + shift[0] + nx * u, p[1] + shift[1] + ny * u, w))
        return ring
    tangents = []
    for i in range(n):
        if closed:
            a, b = pts[(i - 1) % n], pts[(i + 1) % n]
        else:
            a, b = pts[max(i - 1, 0)], pts[min(i + 1, n - 1)]
        L = math.hypot(b[0] - a[0], b[1] - a[1]) or 1.0
        tangents.append(((b[0] - a[0]) / L, (b[1] - a[1]) / L))
    rings = []
    caps = d["caps"]
    if not closed:
        tx, ty = tangents[0]
        for k in range(caps, 0, -1):
            f = 0.5 * math.pi * k / (caps + 1)
            rings.append(section(pts[0], -ty, tx, math.cos(f), (-tx * rx * math.sin(f), -ty * rx * math.sin(f))))
    for i in range(n):
        tx, ty = tangents[i]
        rings.append(section(pts[i], -ty, tx, 1.0))
    if not closed:
        tx, ty = tangents[-1]
        for k in range(1, caps + 1):
            f = 0.5 * math.pi * k / (caps + 1)
            rings.append(section(pts[-1], -ty, tx, math.cos(f), (tx * rx * math.sin(f), ty * rx * math.sin(f))))
    V, F = [], []
    for r in rings:
        V.extend(r)
    m = len(rings)
    for j in range(m if closed else m - 1):
        j2 = (j + 1) % m
        for i in range(sides):
            F.append((j * sides + i, j * sides + (i + 1) % sides, j2 * sides + (i + 1) % sides, j2 * sides + i))
    if not closed:
        tx, ty = tangents[0]
        V.append((pts[0][0] - tx * rx, pts[0][1] - ty * rx, 0.0))
        first = len(V) - 1
        tx, ty = tangents[-1]
        V.append((pts[-1][0] + tx * rx, pts[-1][1] + ty * rx, 0.0))
        end = len(V) - 1
        for i in range(sides):
            F.append((first, (i + 1) % sides, i))
            F.append((end, (m - 1) * sides + i, (m - 1) * sides + (i + 1) % sides))
    return _closed(V, F)


def _rbox(sx, sy, sz, r, d):
    """A closed box with round edges. Rows sit at even angles around the edges, the faces stay one cell."""
    half = (sx * 0.5, sy * 0.5, sz * 0.5)
    r = min(r, min(half) * 0.98)
    inner = tuple(h - r for h in half)
    n = d["n"]
    def coords(i):
        tail = [r * math.tan(math.radians(45.0 * k / n)) for k in range(1, n + 1)]
        out = [-inner[i] - t for t in reversed(tail)] + [-inner[i], inner[i]] + [inner[i] + t for t in tail]
        return out
    V, F = [], []
    seen = {}
    def vert(p):
        c = tuple(max(-inner[k], min(inner[k], p[k])) for k in range(3))
        q = [p[k] - c[k] for k in range(3)]
        L = math.sqrt(q[0] ** 2 + q[1] ** 2 + q[2] ** 2) or 1.0
        out = tuple(c[k] + q[k] * r / L for k in range(3))
        key = tuple(round(v, 7) for v in out)
        if key not in seen:
            seen[key] = len(V)
            V.append(out)
        return seen[key]
    for w in range(3):
        u, v = (w + 1) % 3, (w + 2) % 3
        cu, cv = coords(u), coords(v)
        for sign in (1, -1):
            for a in range(len(cu) - 1):
                for b in range(len(cv) - 1):
                    quad = []
                    for ua, vb in ((cu[a], cv[b]), (cu[a + 1], cv[b]), (cu[a + 1], cv[b + 1]), (cu[a], cv[b + 1])):
                        p = [0.0, 0.0, 0.0]
                        p[w] = sign * half[w]
                        p[u] = ua
                        p[v] = vb
                        quad.append(vert(p))
                    F.append(tuple(quad) if sign > 0 else tuple(reversed(quad)))
    return _closed(V, F)


def _xf(mesh, t=(0.0, 0.0, 0.0), rx=0.0, ry=0.0, rz=0.0, aim=None):
    """Rotate about x, then y, then z, or turn +z onto `aim`, then move."""
    V, F = mesh
    if aim is not None:
        L = math.sqrt(aim[0] ** 2 + aim[1] ** 2 + aim[2] ** 2)
        ax, ay, az = aim[0] / L, aim[1] / L, aim[2] / L
        # Rodrigues rotation from +z to the aim direction
        kx, ky = -ay, ax
        s = math.hypot(kx, ky)
        c = az
        if s < 1e-9:
            V = [(x, y * (1 if c > 0 else -1), z * (1 if c > 0 else -1)) for x, y, z in V]
        else:
            kx, ky = kx / s, ky / s
            out = []
            for x, y, z in V:
                dot = kx * x + ky * y
                cx, cy, cz = ky * z, -kx * z, kx * y - ky * x
                out.append((x * c + cx * s + kx * dot * (1 - c), y * c + cy * s + ky * dot * (1 - c), z * c + cz * s))
            V = out
    for axis, deg in ((0, rx), (1, ry), (2, rz)):
        if deg:
            ca, sa = math.cos(math.radians(deg)), math.sin(math.radians(deg))
            if axis == 0:
                V = [(x, y * ca - z * sa, y * sa + z * ca) for x, y, z in V]
            elif axis == 1:
                V = [(x * ca + z * sa, y, -x * sa + z * ca) for x, y, z in V]
            else:
                V = [(x * ca - y * sa, x * sa + y * ca, z) for x, y, z in V]
    return [(x + t[0], y + t[1], z + t[2]) for x, y, z in V], F


def _build_magnifier(d, add):
    R, tr = 0.15, 0.034
    add("prop_white", _tube(_arc(0, 0, R, 0, 360, d["arc"]), tr, tr, d, closed=True))
    add("prop_glass", _lathe(_fillet([(0.0, -0.018), (R - 0.004, -0.012), (R - 0.004, 0.012), (0.0, 0.032)], 0.012, d["fil"]), d["seg"]))
    c, s = math.cos(math.radians(225)), math.sin(math.radians(225))
    add("prop_white", _tube([(c * (R + 0.03), s * (R + 0.03)), (c * (R + 0.29), s * (R + 0.29))], 0.038, 0.038, d))


def _build_megaphone(d, add):
    shell = [(0.0, 0.0), (0.052, 0.0), (0.062, 0.03), (0.2, 0.31), (0.212, 0.33), (0.194, 0.342), (0.168, 0.322), (0.036, 0.09), (0.0, 0.08)]
    aim = (-0.8, 0.12, 0.62)
    add("prop_white", _xf(_lathe(_fillet(shell, 0.014, d["fil"]), d["seg"]), aim=aim))
    add("prop_orange", _xf(_xf(_ball(0.056, d), t=(0, 0, 0.2)), aim=aim))
    add("prop_orange", _xf(_lathe(_fillet([(0.0, -0.075), (0.052, -0.075), (0.066, -0.04), (0.066, 0.03), (0.0, 0.03)], 0.016, d["fil"]), d["seg"]), aim=aim))


def _build_camera(d, add):
    add("prop_white", _rbox(0.56, 0.36, 0.2, 0.075, d))
    add("prop_white", _xf(_rbox(0.25, 0.14, 0.15, 0.05, d), t=(0.0, 0.2, 0.0)))
    add("prop_white", _lathe(_fillet([(0.0, 0.08), (0.142, 0.08), (0.142, 0.135), (0.12, 0.158), (0.0, 0.158)], 0.016, d["fil"]), d["seg"]))
    add("prop_dark", _lathe(_fillet([(0.0, 0.12), (0.106, 0.12), (0.106, 0.16), (0.07, 0.182), (0.0, 0.186)], 0.016, d["fil"]), d["seg"]))
    add("prop_dark", _xf(_rbox(0.08, 0.044, 0.03, 0.012, d), t=(0.2, 0.125, 0.092)))
    add("prop_dark", _xf(_rbox(0.075, 0.04, 0.05, 0.014, d), t=(-0.2, 0.185, 0.0)))


def _build_funnel(d, add):
    aim = (-0.72, 0.62, 0.3)
    shell = [(0.0, 0.0), (0.036, 0.0), (0.044, 0.02), (0.048, 0.16), (0.2, 0.37), (0.19, 0.384), (0.168, 0.362), (0.03, 0.178), (0.0, 0.165)]
    add("prop_white", _xf(_lathe(_fillet(shell, 0.014, d["fil"]), d["seg"]), aim=aim))
    add("prop_green", _xf(_xf(_tube(_arc(0, 0, 0.192, 0, 360, d["arc"]), 0.027, 0.027, d, closed=True), t=(0, 0, 0.372)), aim=aim))


def _build_magnet(d, add):
    R, L, r = 0.15, 0.1, 0.07
    path = [(L, R), (0.0, R)] + _arc(0, 0, R, 90, 270, d["arc"] // 2)[1:-1] + [(0.0, -R), (L, -R)]
    add("prop_red", _tube(path, r, r * 0.95, d, e=3.0))
    add("prop_steel", _xf(_rbox(0.1, 0.165, 0.15, 0.024, d), t=(L + 0.055, R, 0.0)))
    add("prop_steel", _xf(_rbox(0.1, 0.165, 0.15, 0.024, d), t=(L + 0.055, -R, 0.0)))


def _build_chart(d, add):
    w, gap, depth = 0.158, 0.024, 0.135
    for i, h in enumerate((0.2, 0.34, 0.52)):
        add("prop_green", _xf(_rbox(w, h, depth, 0.034, d), t=((i - 1) * (w + gap), h * 0.5, 0.0)))


def _build_calendar(d, add):
    W, H, D = 0.42, 0.46, 0.08
    add("prop_white", _rbox(W, H, D, 0.036, d))
    add("prop_red", _xf(_rbox(W + 0.012, 0.125, D + 0.014, 0.036, d), t=(0.0, H * 0.5 - 0.0575, 0.0)))
    for sx in (-1, 1):
        ring = _tube(_arc(0, 0, 0.034, -30, 210, d["arc"] // 3), 0.014, 0.014, d)
        add("prop_white", _xf(ring, t=(sx * 0.095, H * 0.5 + 0.012, 0.03), ry=90))
    for row in range(3):
        for col in range(3):
            add("prop_grey", _xf(_rbox(0.09, 0.066, 0.016, 0.009, dict(d, n=max(1, d["n"] // 2))), t=((col - 1) * 0.122, (0.5 - row) * 0.095, D * 0.5 + 0.002)))


def _build_wrench(d, add):
    # A chunky head about twice the handle's width, with a short open mouth.
    R, jaw = 0.125, 0.05
    head = [(jaw, R), (0.0, R)] + _arc(0, 0, R, 90, 270, d["arc"] // 2)[1:-1] + [(0.0, -R), (jaw, -R)]
    add("prop_steel", _xf(_tube(head, 0.076, 0.05, d, e=2.8), rz=-20.0))
    add("prop_steel", _tube([(-R - 0.03, 0.0), (-0.56, 0.0)], 0.058, 0.046, d, e=2.8))


# anchor is where the middle of the tool floats, from the bot's centre in bot sizes, read off the
# art. The tilt is applied once, and it is what makes a flat tool read as a solid toy.
PROP_SPEC = {
    "magnifier": dict(build=_build_magnifier, anchor=(-0.33, -0.14), side="left", tilt=dict(ry=16.0, rx=-6.0)),
    "megaphone": dict(build=_build_megaphone, anchor=(-0.4, -0.12), side="left", tilt=dict(rz=4.0)),
    "camera": dict(build=_build_camera, anchor=(0.09, -0.26), side="right", tilt=dict(ry=-16.0, rx=6.0, rz=9.0), scale=0.82),
    "funnel": dict(build=_build_funnel, anchor=(-0.36, -0.27), side="left", tilt=dict()),
    "magnet": dict(build=_build_magnet, anchor=(-0.44, -0.155), side="left", tilt=dict(ry=-18.0, rz=-10.0)),
    "chart": dict(build=_build_chart, anchor=(0.35, -0.23), side="right", tilt=dict(ry=-24.0, rx=8.0, rz=4.0)),
    "calendar": dict(build=_build_calendar, anchor=(0.27, -0.31), side="right", tilt=dict(ry=-16.0, rx=6.0, rz=-10.0), scale=0.9),
    "wrench": dict(build=_build_wrench, anchor=(0.42, -0.16), side="right", tilt=dict(rz=45.0, ry=-18.0, rx=-8.0), scale=0.9),
}
_PROP_UNITS = {}


def _unit_prop(name, detail):
    """The tool in art axes, its bounding box centred on the origin, as {material: (V, F)}."""
    key = (name, detail)
    if key in _PROP_UNITS:
        return _PROP_UNITS[key]
    if name not in PROP_SPEC:
        raise ValueError("unknown prop %r, have %s" % (name, ", ".join(PROPS)))
    spec = PROP_SPEC[name]
    groups = {}
    def add(mat, mesh):
        V, F = mesh
        g = groups.setdefault(mat, ([], []))
        n = len(g[0])
        g[0].extend(V)
        g[1].extend(tuple(i + n for i in f) for f in F)
    spec["build"](_PROP_DETAIL[detail], add)
    k = spec.get("scale", 1.0)
    out = {m: _xf(([(x * k, y * k, z * k) for x, y, z in g[0]], g[1]), **spec["tilt"]) for m, g in groups.items()}
    every = [p for g in out.values() for p in g[0]]
    mid = [0.5 * (min(p[i] for p in every) + max(p[i] for p in every)) for i in range(3)]
    out = {m: ([(x - mid[0], y - mid[1], z - mid[2]) for x, y, z in g[0]], g[1]) for m, g in out.items()}
    _PROP_UNITS[key] = out
    return out


def prop_mesh(name, size=1.0, detail="film", up="z"):
    """One tool on its own, centred on the origin. Returns a list of parts: dict(mat, v, f).

    size is the bot size the tool goes with, so a tool from the art comes out at the art's scale.
    Materials are the keys of PROP_MATERIALS. Axes follow mascot_mesh.
    """
    parts = []
    for mat, (V, F) in _unit_prop(name, detail).items():
        if up == "z":
            v = [(x * size, -z * size, y * size) for x, y, z in V]
        else:
            v = [(x * size, y * size, z * size) for x, y, z in V]
        parts.append(dict(mat=mat, v=v, f=list(F)))
    return parts


def _face_points(V, F, step=0.035):
    """Points across each face, so a body bulge is caught between a flat tool's far apart vertices."""
    for f in F:
        a, b, c = V[f[0]], V[f[1]], V[f[2]]
        e = V[f[3]] if len(f) == 4 else c
        nu = max(1, int(math.ceil(max(math.dist(a, b), math.dist(e, c)) / step)))
        nv = max(1, int(math.ceil(max(math.dist(b, c), math.dist(a, e)) / step)))
        for i in range(nu + 1):
            u = i / nu
            for j in range(nv + 1):
                v = j / nv
                yield tuple((1 - u) * (1 - v) * a[k] + u * (1 - v) * b[k] + u * v * c[k] + (1 - u) * v * e[k] for k in range(3))


_PROP_FORWARD = {}


def _prop_forward(name, shape, ax, ay, sx, scale, body):
    """How far forward the tool must sit to clear the body. Measured once on the rt mesh, so a tool
    keeps its place at every detail level."""
    key = (name, shape, sx, round(scale, 4), round(ay, 4))
    if key not in _PROP_FORWARD:
        forward = -1e9
        for V, F in _unit_prop(name, "rt").values():
            pts = [(x * sx * scale + ax, y * scale + ay, z * scale) for x, y, z in V]
            for x, y, z in _face_points(pts, F):
                s_, rho = body.locate(x * 2.0, y * 2.0)
                px, py = body.at(s_)
                if math.hypot(x * 2.0, y * 2.0) < math.hypot(px, py):
                    forward = max(forward, body.height(s_, rho) * 0.5 - z)
        # A tool that misses the body altogether still floats level with the bot's middle.
        _PROP_FORWARD[key] = max(forward, 0.0) + 0.022
    return _PROP_FORWARD[key]


def placed_prop(name, shape="sphere", size=1.0, base=(0.0, 0.0, 0.0), facing=0.0, pitch=0.0, detail="film", side=None, scale=1.0, lift=0.0, accent_mat=None):
    """A tool floating beside a bot. Pass the same size, base, facing and pitch as placed_mesh.

    The tool stays clear of that bot's surface and of the ground, and turns with the bot.
    side    "left" or "right" of the bot as seen from the front. None uses the art's side. The other
            side mirrors the tool, for a bot with a building on that side.
    scale   tool size against the art. 1.2 helps a tool read in a very wide shot.
    lift    extra height in bot sizes.
    accent_mat  a material name for the tool's coloured part, to carry the bot's own colour.

    Returns a list of parts: dict(mat, v, f), in Blender axes, with mat a key of PROP_MATERIALS.
    """
    spec = PROP_SPEC.get(name)
    if spec is None:
        raise ValueError("unknown prop %r, have %s" % (name, ", ".join(PROPS)))
    use_side = side or spec["side"]
    if use_side not in ("left", "right"):
        raise ValueError("side must be left or right")
    mirror = use_side != spec["side"]
    unit = _unit_prop(name, detail)
    m = mascot_mesh(shape, size=1.0, detail="rt", up="y")
    b = _body(shape)
    # Anchors come from a body about 1 wide and 1 tall, so wider or taller bodies push the tool out with them.
    ax, ay = spec["anchor"]
    ax *= m["width"] * (-1.0 if mirror else 1.0)
    ay *= m["height"]
    sx = -1.0 if mirror else 1.0
    placed = {}
    for mat, (V, F) in unit.items():
        placed[mat] = ([(x * sx * scale + ax, y * scale + ay, z * scale) for x, y, z in V], F)
    # Up far enough to float above the ground, then forward far enough to clear the body there.
    low = min(p[1] for V, _ in placed.values() for p in V) + m["center_up"]
    rise = max(0.0, 0.035 - low) + lift
    forward = _prop_forward(name, shape, ax, ay + rise, sx, scale, b)
    cf, sf = math.cos(facing), math.sin(facing)
    cp, sp = math.cos(pitch), math.sin(pitch)
    pivot = m["center_up"] * size
    def go(p):
        x = p[0] * size
        y = -(p[2] + forward) * size
        z = (p[1] + m["center_up"] + rise) * size - pivot
        y, z = y * cp - z * sp, y * sp + z * cp
        x, y = x * cf - y * sf, x * sf + y * cf
        return (x + base[0], y + base[1], z + pivot + base[2])
    parts = []
    accent = {"prop_red", "prop_green", "prop_orange"}
    for mat, (V, F) in placed.items():
        f = [tuple(reversed(q)) for q in F] if mirror else list(F)
        parts.append(dict(mat=accent_mat if accent_mat and mat in accent else mat, v=[go(p) for p in V], f=f))
    return parts


def face_normals_outward(verts, faces):
    """Signed volume of a closed mesh. Positive means the faces wind outward."""
    vol = 0.0
    for f in faces:
        a = verts[f[0]]
        for k in range(1, len(f) - 1):
            b, c = verts[f[k]], verts[f[k + 1]]
            vol += (a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6.0
    return vol


def make_blender_materials(bpy, color_hex="#fba42a", name="bot"):
    """Optional helper for a script that has no material system of its own. Pass the bpy module in."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    n = m.node_tree.nodes["Principled BSDF"]
    n.inputs["Base Color"].default_value = (*srgb_to_linear(color_hex), 1)
    n.inputs["Roughness"].default_value = GLOSSY["roughness"]
    n.inputs["Coat Weight"].default_value = GLOSSY["coat"]
    n.inputs["Coat Roughness"].default_value = GLOSSY["coat_roughness"]
    n.inputs["Subsurface Weight"].default_value = GLOSSY["sss"]
    n.inputs["Subsurface Radius"].default_value = (1.0, 0.55, 0.35)
    n.inputs["Subsurface Scale"].default_value = GLOSSY["sss_scale"]
    e = bpy.data.materials.new(name + "_eye")
    e.use_nodes = True
    k = e.node_tree.nodes["Principled BSDF"]
    k.inputs["Base Color"].default_value = (*EYE_MATERIAL["base"], 1)
    k.inputs["Roughness"].default_value = EYE_MATERIAL["roughness"]
    k.inputs["Coat Weight"].default_value = EYE_MATERIAL["coat"]
    k.inputs["Coat Roughness"].default_value = EYE_MATERIAL["coat_roughness"]
    return m, e
