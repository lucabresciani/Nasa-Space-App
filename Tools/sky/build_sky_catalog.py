#!/usr/bin/env python3
"""Build Assets/Mars/Resources/MarsSkyCatalog.txt, the real night sky drawn by MarsNightSky.

What it makes (format in SPEC section 6, repeated in the output header):
    S <ra> <dec> <mag> <bv>        every star to V = 6.0, sorted by magnitude
    N <ra> <dec> <mag> <name>      stars with an IAU proper name and V <= 3.5 (label anchors)
    C <ra> <dec> <rank> <name>     constellation label anchors, IAU names, rank 1..3
    L <ra1> <dec1> <ra2> <dec2>    constellation stick-figure segments
RA/Dec in degrees, J2000 equatorial, RA in [0, 360). UTF-8, LF, invariant number format ('.' decimal point, no
grouping), name last on its line (it may contain spaces, never '#', which the reader treats as a comment).

Sources. Every star position, magnitude and colour is NASA data; two non-NASA inputs are declared exceptions.
- NASA (S records; positions and magnitudes of the N records; the stars the L endpoints are snapped to):
  the Bright Star Catalogue, 5th Revised Ed. (Preliminary Version), Hoffleit D. & Warren W.H. Jr. 1991, Yale University
  Observatory, as served by NASA HEASARC, table heasarc_bsc5p:
      https://heasarc.gsfc.nasa.gov/W3Browse/star-catalog/bsc5p.html
      https://heasarc.gsfc.nasa.gov/FTP/heasarc/dbase/tdat_files/heasarc_bsc5p.tdat.gz   (TDAT, read as-is, gzip or not)
  Fields used: hr (the table's unique key), hd, ra / dec (J2000, degrees), vmag (the BSC5 visual magnitude; HEASARC's
  field note calls it "Photographic Magnitude", but it is the catalogue's Vmag), bv_color (B-V), pmra / pmdec (only
  for the proper-motion note in the header). Column order is taken from the file's own "line[1]" declaration, never
  assumed. Rows without a position or a magnitude are the BSC's non-stellar entries (novae, clusters, a galaxy, which
  the catalogue keeps as numbered placeholders) and are skipped and counted.
- Declared exception 1, IAU (N record names only): the IAU Catalog of Star Names, IAU Division C Working Group on Star
  Names (WGSN), text version IAU-CSN, https://www.pas.rochester.edu/~emamajek/WGSN/IAU-CSN.txt (official list:
  https://www.iau.org/public/themes/naming_stars/). Its header releases IAU products under Creative Commons
  Attribution and asks users to cite the IAU. Only the name text is used: each name is matched to its BSC star by the
  HR number in its "Designation" column (by the HD column where the designation is not an HR number), then checked
  against the IAU's own J2000 position (must agree within NAME_POS_TOL_DEG), and the N record carries the BSC's
  position and magnitude. Names are written in the file's "Name/Diacritics" form (the official spelling).
- Declared exception 2, d3-celestial by Olaf Frohn, https://github.com/ofrohn/d3-celestial , BSD-3-Clause (its LICENSE
  is reproduced in the output header, as the licence requires), data/ folder:
      constellations.json        C records: IAU constellation names, rank (1-3, "for differential name display by
                                 size/brightness") and label position; README: IAU constellation page, name positions
                                 by O. Frohn.
      constellations.lines.json  L records: stick figures; README: IAU constellation page, "some line modifications"
                                 by O. Frohn. These are drawing conventions, not measurements.
  d3-celestial's own star and name files are no longer used.

Choices made here (not in the source data):
- A star whose BSC row has no B-V gets 0.65 (a solar-type colour, i.e. nearly white once the renderer desaturates it).
- Constellation labels use the IAU name (field "name": "Orion", "Ursa Major"). d3-celestial's "en" field is a loose
  translation with collisions ("Compass" for both Circinus and Pyxis) and errors (Ursa Major = "Big Dipper").
- Serpens is one constellation in two separate parts; d3-celestial gives each part its own anchor (Serpens Caput,
  Serpens Cauda), so there are 89 anchors for 88 constellations.
- Line endpoints (d3-celestial drew them on Hipparcos-based positions) are snapped to the nearest drawn BSC star
  (V <= 6.0) within SNAP_DEG, else to the nearest BSC star of any magnitude within SNAP_DEG, so lines end exactly on
  the star points; an endpoint with no BSC star that close is kept as given and counted in the report and the header.
- Positions are the BSC's J2000 (FK5, epoch 2000) values without proper motion; the header states the largest
  catalogued proper motion among the written stars and how far that star drifts by 2035.

The input files are untrusted data: they are only parsed (text split, json module with NaN/Infinity rejected), every
field is type- and range-checked, and nothing in them is ever executed or used as a path.

Usage:
    python -I Tools/sky/build_sky_catalog.py --bsc <heasarc_bsc5p.tdat.gz> --names <IAU-CSN.txt> \
        --d3 <dir with constellations.json, constellations.lines.json, LICENSE> \
        --out Assets/Mars/Resources/MarsSkyCatalog.txt
Standard library only (Python 3.8+). Prints a short report; exits non-zero when the input is malformed.
"""

import argparse
import bisect
import datetime
import gzip
import hashlib
import io
import json
import math
import os
import re
import sys
import unicodedata

STAR_MAG_LIMIT = 6.0        # SPEC 6: the faintest stars the renderer can show (MarsNightSky.limitingMagnitude <= 6)
NAME_MAG_LIMIT = 3.5        # SPEC 6: label anchors; the renderer filters further (starNameMagnitude, default 2.0)
MISSING_BV = 0.65           # SPEC 6: colour index used when the source has none
SNAP_DEG = 0.1              # line endpoint -> BSC star matching radius
NAME_POS_TOL_DEG = 0.1      # IAU-CSN position vs the matched BSC star: a wrong join would be off by degrees
MAX_FILE_BYTES = 32 << 20   # refuse absurdly large inputs (the real files are < 3 MB uncompressed)
MAX_NAME_LEN = 40
YEARS_TO_2035 = 35.0        # J2000 -> 2035, the end of the span the sky code is checked for

D3_INPUTS = ("constellations.json", "constellations.lines.json", "LICENSE")
BSC_FIELDS = ("hr", "hd", "ra", "dec", "vmag", "bv_color", "pmra", "pmdec", "name")
HEASARC_TABLE_URL = "https://heasarc.gsfc.nasa.gov/W3Browse/star-catalog/bsc5p.html"
HEASARC_FILE_URL = "https://heasarc.gsfc.nasa.gov/FTP/heasarc/dbase/tdat_files/heasarc_bsc5p.tdat.gz"
IAU_CSN_URL = "https://www.pas.rochester.edu/~emamajek/WGSN/IAU-CSN.txt"
IAU_NAMES_URL = "https://www.iau.org/public/themes/naming_stars/"
D3_URL = "https://github.com/ofrohn/d3-celestial"


class DataError(Exception):
    pass


# ----------------------------------------------------------------------------------------------- reading & checking

def read_bytes(path):
    try:
        size = os.path.getsize(path)
        if size > MAX_FILE_BYTES:
            raise DataError("%s is %d bytes, more than the %d allowed" % (path, size, MAX_FILE_BYTES))
        with open(path, "rb") as f:
            data = f.read()
    except OSError as e:
        raise DataError("cannot read %s: %s" % (path, e))
    if data[:2] == b"\x1f\x8b":     # gzip magic: decompress with a size bound (no zip bomb)
        try:
            with gzip.GzipFile(fileobj=io.BytesIO(data)) as g:
                data = g.read(MAX_FILE_BYTES + 1)
        except (OSError, EOFError) as e:
            raise DataError("%s is not a valid gzip file: %s" % (path, e))
        if len(data) > MAX_FILE_BYTES:
            raise DataError("%s decompresses to more than %d bytes" % (path, MAX_FILE_BYTES))
    return data


def decode(path, data):
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError as e:
        raise DataError("%s is not UTF-8: %s" % (path, e))


def reject_constant(token):
    # json accepts NaN / Infinity / -Infinity by default; they are not JSON and never valid here.
    raise DataError("non-finite number %r in input" % token)


def parse_json(name, data):
    try:
        return json.loads(data.decode("utf-8-sig"), parse_constant=reject_constant)
    except (UnicodeDecodeError, ValueError) as e:
        raise DataError("%s is not valid UTF-8 JSON: %s" % (name, e))


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def git_blob_sha1(data):
    """The id git gives this content; compare with GitHub's tree listing to know which upstream commit it came from."""
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def number(value, what):
    if isinstance(value, bool):
        raise DataError("%s: boolean where a number was expected" % what)
    if isinstance(value, (int, float)):
        x = float(value)
    elif isinstance(value, str):
        try:
            x = float(value.strip())
        except ValueError:
            raise DataError("%s: %r is not a number" % (what, value))
    else:
        raise DataError("%s: %r is not a number" % (what, value))
    if not math.isfinite(x):
        raise DataError("%s: non-finite %r" % (what, value))
    return x


def optional_number(text, what, lo, hi):
    """'' -> None; otherwise a finite float in [lo, hi]."""
    text = text.strip()
    if not text:
        return None
    x = number(text, what)
    if not lo <= x <= hi:
        raise DataError("%s: %g out of range [%g, %g]" % (what, x, lo, hi))
    return x


def optional_int(text, what):
    text = text.strip()
    if not text:
        return None
    if not re.fullmatch(r"[0-9]{1,9}", text):
        raise DataError("%s: %r is not a catalogue number" % (what, text))
    return int(text)


def clean_name(value):
    """A display name, or None. Unicode NFC, any whitespace (thin space, no-break space...) -> one plain space,
    no control characters, no '#' (the catalogue reader's comment mark), bounded length; so a name can never break
    the one-record-per-line format."""
    if not isinstance(value, str):
        return None
    s = unicodedata.normalize("NFC", value)
    # Invisible format marks (bidi marks, zero-width joiners: category Cf) are dropped; whitespace becomes a space.
    s = "".join(" " if ch.isspace() else ch for ch in s if unicodedata.category(ch) != "Cf")
    s = " ".join(s.split())
    if not s or len(s) > MAX_NAME_LEN or "#" in s:
        return None
    if any(unicodedata.category(ch)[0] in ("C", "Z") and ch != " " for ch in s):
        return None
    return s


def unit(ra, dec):
    a, d = math.radians(ra), math.radians(dec)
    return (math.cos(d) * math.cos(a), math.cos(d) * math.sin(a), math.sin(d))


def separation_deg(u, v):
    # Chord length -> angle: well conditioned for the tiny separations tested here (acos of a dot product is not).
    c = math.sqrt((u[0] - v[0]) ** 2 + (u[1] - v[1]) ** 2 + (u[2] - v[2]) ** 2)
    return math.degrees(2.0 * math.asin(min(1.0, c / 2.0)))


# ----------------------------------------------------------------------------------------------- NASA HEASARC BSC5P

def read_bsc(path):
    """Parse the HEASARC TDAT file. Returns (stars by HR, skipped HR numbers, metadata).

    TDAT: a <HEADER> block of 'key = value' lines, among them field[...] declarations and line[1] = the column order of
    each '|'-separated data row (one line per row here), then <DATA> ... <END>. Every row ends with a '|'."""
    raw = read_bytes(path)
    text = decode(path, raw).replace("\r\n", "\n").replace("\r", "\n")
    head, sep, rest = text.partition("<DATA>")
    if not sep or "<HEADER>" not in head:
        raise DataError("%s is not a TDAT file (no <HEADER> / <DATA>)" % path)
    body, sep, _ = rest.partition("<END>")
    if not sep:
        raise DataError("%s: <END> missing (truncated download?)" % path)

    meta, declared, order = {}, set(), None
    for line in head.split("\n"):
        line = line.strip()
        m = re.match(r"#\s*(TOTAL ROWS|LAST MODIFIED)\s*:\s*(.+)$", line)
        if m:
            meta[m.group(1)] = m.group(2).strip()
            continue
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = (s.strip() for s in line.partition("="))
        m = re.fullmatch(r"field\[([a-z0-9_]+)\]", key)
        if m:
            declared.add(m.group(1))
        elif re.fullmatch(r"line\[[0-9]+\]", key):
            if order is not None:
                raise DataError("%s: rows spread over several line[] declarations are not supported" % path)
            order = value.split()
        elif key == "table_name":
            meta["table_name"] = value
    if order is None:
        raise DataError("%s: no line[1] column-order declaration" % path)
    missing = [f for f in BSC_FIELDS if f not in order or f not in declared]
    if missing:
        raise DataError("%s: fields %s not in the header" % (path, ", ".join(missing)))
    if meta.get("table_name") != "heasarc_bsc5p":
        raise DataError("%s: table_name is %r, not heasarc_bsc5p" % (path, meta.get("table_name")))
    col = {name: i for i, name in enumerate(order)}

    stars, skipped, rows = {}, [], 0
    for n, line in enumerate(body.split("\n")):
        if not line.strip():
            continue
        rows += 1
        cells = line.split("|")
        # One trailing '|' per row, so one more cell than columns (the last one empty).
        if len(cells) != len(order) + 1 or cells[-1].strip():
            raise DataError("%s data row %d has %d cells, expected %d + 1" % (path, n + 1, len(cells), len(order)))
        what = "%s data row %d" % (path, n + 1)
        hr = optional_int(cells[col["hr"]], what + " hr")
        if hr is None or hr == 0:
            raise DataError(what + ": no HR number")
        what = "BSC HR %d" % hr
        if hr in stars or hr in skipped:
            raise DataError(what + " appears twice")
        ra = optional_number(cells[col["ra"]], what + " ra", 0.0, 360.0)
        dec = optional_number(cells[col["dec"]], what + " dec", -90.0, 90.0)
        mag = optional_number(cells[col["vmag"]], what + " vmag", -2.0, 15.0)
        if ra is None or dec is None or mag is None:
            skipped.append(hr)
            continue
        if ra >= 360.0:
            ra -= 360.0
        stars[hr] = {
            "ra": ra, "dec": dec, "mag": mag,
            # Carbon stars reach B-V ~ 6 in the BSC (HR 1607, C6IIe: 5.74), hence the wide sanity range.
            "bv": optional_number(cells[col["bv_color"]], what + " bv_color", -1.0, 7.0),
            "hd": optional_int(cells[col["hd"]], what + " hd"),
            "pm": math.hypot(optional_number(cells[col["pmra"]], what + " pmra", -20.0, 20.0) or 0.0,
                             optional_number(cells[col["pmdec"]], what + " pmdec", -20.0, 20.0) or 0.0),
            "label": " ".join(cells[col["name"]].split()),
        }
    total = meta.get("TOTAL ROWS")
    if total is not None and total.isdigit() and int(total) != rows:
        raise DataError("%s: %d data rows, the header says %s (truncated download?)" % (path, rows, total))
    meta["rows"] = rows
    meta["sha256"] = sha256(raw)
    return stars, sorted(skipped), meta


# ----------------------------------------------------------------------------------------------- IAU WGSN names

def read_iau_csn(path):
    """Parse IAU-CSN.txt, a fixed-width table. The column starts come from the file's own heading line
    '#Name/ASCII  Name/Diacritics  Designation  ID ...'; after the Designation column come
    ID ID Con # WDS_J mag bnd HIP HD RA(J2000) Dec(J2000) Date [Notes]."""
    raw = read_bytes(path)
    lines = decode(path, raw).replace("\r\n", "\n").replace("\r", "\n").split("\n")
    heading = next((i for i, l in enumerate(lines) if l.startswith("#Name/ASCII")), None)
    if heading is None:
        raise DataError("%s: no '#Name/ASCII' column heading" % path)
    h = lines[heading]
    p1 = h.find("Name/Diacritics")
    p2 = h.find("Designation")
    p3 = h.find("ID", p2 + len("Designation"))
    if not 0 < p1 < p2 < p3:
        raise DataError("%s: unexpected column heading %r" % (path, h))
    updated = next((l.split("updated", 1)[1].split("(")[0].strip() for l in lines[:heading]
                    if l.startswith("#") and "Last updated" in l), "unknown date")

    entries = []
    for n in range(heading + 1, len(lines)):
        line = lines[n]
        if not line.strip() or line.startswith("#"):
            continue
        what = "%s line %d" % (path, n + 1)
        if len(line) <= p3 or line[p1 - 1] != " " or line[p2 - 1] != " " or line[p3 - 1] != " ":
            raise DataError(what + ": does not fit the fixed columns")
        # The middle columns are sometimes left blank instead of '_' (Mebsuta has no component letter), so the fields
        # used are read from the right, anchored on the approval date: ... mag bnd HIP HD RA Dec Date [Notes].
        rest = line[p3:].split()
        if rest and not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", rest[-1]):
            rest.pop()      # the optional Notes field
        if len(rest) < 10 or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", rest[-1]):
            raise DataError("%s: fields after the designation do not end in 'RA Dec Date [Notes]'" % what)
        mag, hd, ra, dec = rest[-7], rest[-4], rest[-3], rest[-2]
        name = clean_name(line[p1:p2])
        if name is None:
            raise DataError("%s: unusable name %r" % (what, line[p1:p2]))
        desig = " ".join(line[p2:p3].split())
        m = re.fullmatch(r"HR ([0-9]{1,5})", desig)
        entries.append({
            "name": name, "designation": desig,
            "hr": int(m.group(1)) if m else None,
            "hd": int(hd) if re.fullmatch(r"[0-9]{1,9}", hd) else None,
            "mag": float(mag) if re.fullmatch(r"-?[0-9]+(\.[0-9]+)?", mag) else None,
            "ra": number(ra, what + " RA"), "dec": number(dec, what + " Dec"),
        })
    if len({e["name"].casefold() for e in entries}) != len(entries):
        raise DataError("%s: a name appears twice" % path)
    return entries, updated, sha256(raw)


def build_names(entries, stars):
    """Match each IAU name to its BSC star; keep those with BSC V <= NAME_MAG_LIMIT."""
    by_hd = {}
    for hr, s in stars.items():
        if s["hd"] is not None:
            by_hd.setdefault(s["hd"], []).append(hr)
    names, unmatched, mismatched, via_hd = [], [], [], 0
    used = {}
    for e in entries:
        hr = e["hr"] if e["hr"] in stars else None
        if hr is None and e["hd"] is not None and len(by_hd.get(e["hd"], ())) == 1:
            hr = by_hd[e["hd"]][0]
            via_hd += 1
        if hr is None:
            unmatched.append(e)
            continue
        s = stars[hr]
        sep = separation_deg(unit(s["ra"], s["dec"]), unit(e["ra"], e["dec"]))
        if sep > NAME_POS_TOL_DEG:
            mismatched.append((e, hr, sep))
            continue
        if hr in used:
            raise DataError("IAU names %r and %r both match BSC HR %d" % (used[hr], e["name"], hr))
        used[hr] = e["name"]
        if s["mag"] <= NAME_MAG_LIMIT:
            names.append((s["mag"], hr, e["name"]))
    names.sort()
    return names, {"matched": len(used), "via_hd": via_hd, "unmatched": unmatched, "mismatched": mismatched}


# ----------------------------------------------------------------------------------------------- d3-celestial

def point(coords, what):
    """GeoJSON [lon, lat] -> (ra, dec) in degrees, ra in [0, 360). d3-celestial stores RA as lon in [-180, 180]."""
    if not isinstance(coords, list) or len(coords) != 2:
        raise DataError("%s: coordinates %r are not [lon, lat]" % (what, coords))
    lon = number(coords[0], what + " lon")
    lat = number(coords[1], what + " lat")
    if not -180.0 <= lon <= 180.0 or not -90.0 <= lat <= 90.0:
        raise DataError("%s: coordinates %r out of range" % (what, coords))
    ra = lon + 360.0 if lon < 0.0 else lon
    if ra >= 360.0:
        ra -= 360.0
    return ra, lat


def features(doc, name, geometry_type):
    if not isinstance(doc, dict) or doc.get("type") != "FeatureCollection" or not isinstance(doc.get("features"), list):
        raise DataError("%s is not a GeoJSON FeatureCollection" % name)
    out = []
    for i, f in enumerate(doc["features"]):
        what = "%s feature %d" % (name, i)
        if not isinstance(f, dict) or f.get("type") != "Feature":
            raise DataError(what + " is not a Feature")
        g = f.get("geometry")
        if not isinstance(g, dict) or g.get("type") != geometry_type:
            raise DataError("%s: geometry is not a %s" % (what, geometry_type))
        if not isinstance(f.get("properties"), dict):
            raise DataError(what + " has no properties")
        out.append(f)
    return out


def build_constellations(doc):
    out, seen, ids = [], set(), set()
    for f in features(doc, "constellations.json", "Point"):
        ids.add(f.get("id"))
        what = "constellations.json %r" % (f.get("id"),)
        p = f["properties"]
        name = clean_name(p.get("name"))
        if name is None:
            raise DataError(what + ": missing or unusable IAU name")
        if name.casefold() in seen:
            raise DataError(what + ": name %r appears twice" % name)
        seen.add(name.casefold())
        rank = number(p.get("rank"), what + " rank")
        if rank not in (1.0, 2.0, 3.0):
            raise DataError("%s: rank %r is not 1, 2 or 3" % (what, p.get("rank")))
        ra, dec = point(f["geometry"].get("coordinates"), what)
        out.append((int(rank), name, ra, dec))
    out.sort(key=lambda c: (c[0], c[1]))
    return out, len(ids)


class StarIndex:
    """Nearest BSC star within SNAP_DEG: the stars sorted by declination, so each query only measures the stars in a
    +-SNAP_DEG declination band (a handful) instead of all ~9000."""

    def __init__(self, stars):
        self.items = sorted((s["dec"], s["ra"], hr) for hr, s in stars.items())
        self.decs = [it[0] for it in self.items]

    def snap(self, ra, dec):
        u = unit(ra, dec)
        best, best_sep = None, SNAP_DEG
        lo = bisect.bisect_left(self.decs, dec - SNAP_DEG)
        hi = bisect.bisect_right(self.decs, dec + SNAP_DEG)
        for sdec, sra, hr in self.items[lo:hi]:
            sep = separation_deg(u, unit(sra, sdec))
            if sep <= best_sep:
                best, best_sep = hr, sep
        return best, best_sep


def build_lines(doc, stars):
    # Drawn stars (V <= STAR_MAG_LIMIT) first: the BSC lists close pairs as separate rows, and the nearest row to a
    # figure point can be a faint companion a few arcsec from the star the figure means (iota Cnc B, HR 3474, V 6.57,
    # next to iota Cnc A; kappa1 Boo, HR 5328, V 6.69, next to kappa2 Boo). Any BSC star is the fallback.
    drawn = StarIndex({hr: s for hr, s in stars.items() if s["mag"] <= STAR_MAG_LIMIT})
    index = StarIndex(stars)
    segments, keys = [], set()
    raw = duplicates = zero = endpoints = 0
    unmatched, seps, faint = [], [], set()
    for f in features(doc, "constellations.lines.json", "MultiLineString"):
        cid = f.get("id")
        what = "constellations.lines.json %r" % (cid,)
        paths = f["geometry"].get("coordinates")
        if not isinstance(paths, list):
            raise DataError(what + ": coordinates are not a list of lines")
        for path in paths:
            if not isinstance(path, list) or len(path) < 2:
                raise DataError(what + ": a line has fewer than two points")
            pts = []
            for c in path:
                endpoints += 1
                ra, dec = point(c, what)
                hr, sep = drawn.snap(ra, dec)
                if hr is None:
                    hr, sep = index.snap(ra, dec)
                if hr is None:
                    unmatched.append((cid, ra, dec))
                else:
                    seps.append(sep)
                    ra, dec = stars[hr]["ra"], stars[hr]["dec"]
                    if stars[hr]["mag"] > STAR_MAG_LIMIT:
                        faint.add(hr)
                pts.append((fmt_ra(ra), fmt(dec, 3)))
            for a, b in zip(pts, pts[1:]):
                raw += 1
                if a == b:
                    zero += 1
                    continue
                key = (a, b) if a <= b else (b, a)
                if key in keys:
                    duplicates += 1
                    continue
                keys.add(key)
                segments.append((a, b))
    return segments, {"raw": raw, "duplicates": duplicates, "zero": zero, "endpoints": endpoints,
                      "unmatched": unmatched, "seps": sorted(seps), "faint": sorted(faint)}


# ----------------------------------------------------------------------------------------------- formatting

def fmt(x, decimals):
    """Invariant fixed-point text ('.' decimal point, never locale-dependent), without a '-0.000'."""
    s = "%.*f" % (decimals, x)
    if s.startswith("-") and float(s) == 0.0:
        s = s[1:]
    return s


def fmt_ra(ra):
    r = round(ra, 3)
    if r >= 360.0:          # 359.9996 rounds to 360.000; keep RA in [0, 360)
        r -= 360.0
    return fmt(r, 3)


# ----------------------------------------------------------------------------------------------- output

def build(bsc_path, names_path, d3_dir, out_path):
    all_stars, skipped, bsc_meta = read_bsc(bsc_path)
    entries, csn_date, csn_sha = read_iau_csn(names_path)
    d3 = {name: read_bytes(os.path.join(d3_dir, name)) for name in D3_INPUTS}
    licence = decode("LICENSE", d3["LICENSE"])

    shown = {hr: s for hr, s in all_stars.items() if s["mag"] <= STAR_MAG_LIMIT}
    ordered = sorted(shown.items(), key=lambda kv: (kv[1]["mag"], kv[0]))
    missing_bv = sum(1 for _, s in ordered if s["bv"] is None)
    fastest_hr = max(shown, key=lambda hr: shown[hr]["pm"])
    fastest = shown[fastest_hr]

    names, name_stats = build_names(entries, all_stars)
    constellations, n_constellations = build_constellations(parse_json("constellations.json", d3["constellations.json"]))
    segments, ls = build_lines(parse_json("constellations.lines.json", d3["constellations.lines.json"]), all_stars)
    n_unmatched = len(ls["unmatched"])
    max_snap = ls["seps"][-1] * 3600.0 if ls["seps"] else 0.0
    today = datetime.datetime.now(datetime.timezone.utc).date().isoformat()

    lines = [
        "# MarsSkyCatalog.txt - the real night sky drawn by MarsNightSky: stars, star names, constellation labels and lines.",
        "# Generated %s (UTC) by Tools/sky/build_sky_catalog.py; do not edit by hand, re-run the script instead." % today,
        "# See DATA_SOURCES.md, section 'Night sky'.",
        "#",
        "# NASA data - every star position, magnitude and colour (S records, and the position and magnitude of N records):",
        "#   Bright Star Catalogue, 5th Revised Ed. (Preliminary Version), Hoffleit D. & Warren W.H. Jr. 1991, Yale",
        "#   University Observatory; served by NASA HEASARC as table %s (last modified %s), public:"
        % (bsc_meta["table_name"], bsc_meta.get("LAST MODIFIED", "unknown")),
        "#     %s" % HEASARC_TABLE_URL,
        "#     %s" % HEASARC_FILE_URL,
        "#   input sha256 %s; %d rows, %d without a position or magnitude"
        % (bsc_meta["sha256"], bsc_meta["rows"], len(skipped)),
        "#   (the BSC's non-stellar placeholders: HR %s), skipped." % " ".join(str(hr) for hr in skipped),
        "#   Fields: ra/dec J2000 (FK5, epoch 2000), vmag (V), bv_color (B-V). No proper motion applied: the largest in",
        "#   this file, %s (%.2f arcsec/yr), moves %.1f arcmin by 2035." % (fastest["label"], fastest["pm"],
                                                                            fastest["pm"] * YEARS_TO_2035 / 60.0),
        "#",
        "# Not NASA data - the two declared exceptions:",
        "#   1. The name text of N records: IAU Catalog of Star Names (IAU Division C WGSN), text version IAU-CSN,",
        "#      last updated %s, %s" % (csn_date, IAU_CSN_URL),
        "#      (official list: %s), released by the IAU under Creative Commons" % IAU_NAMES_URL,
        "#      Attribution; input sha256 %s." % csn_sha,
        "#      Each name is matched to its BSC star by HR number (HD where the IAU designation is not an HR number).",
        "#   2. C and L records: d3-celestial by Olaf Frohn, %s (data/ folder), BSD-3-Clause" % D3_URL,
        "#      (LICENSE reproduced at the end of this header): IAU constellation names, rank and label positions, and",
        "#      stick figures after the IAU charts with line changes by O. Frohn; drawing conventions, not measurements.",
        "#      Input files and their git blob ids, which identify the upstream revision:",
    ]
    for name in D3_INPUTS:
        lines.append("#        %-26s %s" % (name, git_blob_sha1(d3[name])))
    lines += [
        "#      Line endpoints are moved onto the nearest drawn BSC star within %.1f deg (%d of %d endpoints; largest move"
        % (SNAP_DEG, len(ls["seps"]), ls["endpoints"]),
        "#      %.0f arcsec); %d have no BSC star that close and are kept as given." % (max_snap, n_unmatched),
        "#",
        "# Frame: J2000 equatorial, degrees, RA in [0, 360). Numbers use the invariant format ('.' decimal point).",
        "# One record per line; the name field is last and may contain spaces.",
        "#   S <ra> <dec> <mag> <bv>      %4d stars, V <= %.1f, brightest first (B-V %.2f where the BSC has none: %d)"
        % (len(ordered), STAR_MAG_LIMIT, MISSING_BV, missing_bv),
        "#   N <ra> <dec> <mag> <name>    %4d IAU proper names of stars with V <= %.1f, brightest first"
        % (len(names), NAME_MAG_LIMIT),
        "#   C <ra> <dec> <rank> <name>   %4d constellation label anchors for %d constellations (one per part: Serpens"
        % (len(constellations), n_constellations),
        "#                                     has two), IAU names, rank 1 (most prominent) .. 3, sorted by rank",
        "#   L <ra1> <dec1> <ra2> <dec2>  %4d constellation line segments" % len(segments),
        "#",
        "# d3-celestial LICENSE:",
    ]
    for text in licence.replace("\r\n", "\n").replace("\r", "\n").rstrip("\n").split("\n"):
        text = "".join(ch for ch in text if ch == "\t" or unicodedata.category(ch)[0] != "C")
        lines.append(("# " + text).rstrip())

    for hr, s in ordered:
        bv = MISSING_BV if s["bv"] is None else s["bv"]
        lines.append("S %s %s %s %s" % (fmt_ra(s["ra"]), fmt(s["dec"], 3), fmt(s["mag"], 2), fmt(bv, 2)))
    for mag, hr, name in names:
        s = all_stars[hr]
        lines.append("N %s %s %s %s" % (fmt_ra(s["ra"]), fmt(s["dec"], 3), fmt(mag, 2), name))
    for rank, name, ra, dec in constellations:
        lines.append("C %s %s %d %s" % (fmt_ra(ra), fmt(dec, 3), rank, name))
    for (ra1, dec1), (ra2, dec2) in segments:
        lines.append("L %s %s %s %s" % (ra1, dec1, ra2, dec2))

    text = "\n".join(lines) + "\n"
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    tmp = out_path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    os.replace(tmp, out_path)

    print("wrote %s (%d bytes)" % (out_path, len(text.encode("utf-8"))))
    print("  BSC rows         %5d (%d skipped, no position or magnitude: HR %s)"
          % (bsc_meta["rows"], len(skipped), " ".join(map(str, skipped))))
    print("  S stars          %5d (V <= %.1f; %d without B-V -> %.2f); largest proper motion %s %.2f\"/yr"
          % (len(ordered), STAR_MAG_LIMIT, missing_bv, MISSING_BV, fastest["label"], fastest["pm"]))
    print("  N named stars    %5d (V <= %.1f) of %d IAU names: %d matched to the BSC (%d by HD), %d not in the BSC, "
          "%d position mismatches" % (len(names), NAME_MAG_LIMIT, len(entries), name_stats["matched"],
                                      name_stats["via_hd"], len(name_stats["unmatched"]), len(name_stats["mismatched"])))
    um = name_stats["unmatched"]
    bright_um = [e for e in um if e["mag"] is not None and e["mag"] <= 6.5]
    print("      unmatched names with IAU mag <= 6.5 (the BSC limit): %s"
          % (", ".join("%s (%s, %.2f)" % (e["name"], e["designation"], e["mag"]) for e in bright_um) or "none"))
    print("      unmatched names fainter than 6.5 or without mag: %d" % (len(um) - len(bright_um)))
    for e, hr, sep in name_stats["mismatched"]:
        print("      position mismatch: %s (%s) vs BSC HR %d: %.3f deg" % (e["name"], e["designation"], hr, sep))
    print("  C anchors        %5d (%d constellations)" % (len(constellations), n_constellations))
    print("  L segments       %5d (%d in the source, %d duplicates and %d zero-length removed)"
          % (len(segments), ls["raw"], ls["duplicates"], ls["zero"]))
    s = ls["seps"]
    print("    endpoints %d: snapped %d (<= 1\": %d, <= 10\": %d, <= 60\": %d, max %.1f\"), to a star fainter than %.1f: %d,"
          " none within %.1f deg: %d" % (ls["endpoints"], len(s), sum(x <= 1 / 3600 for x in s),
                                         sum(x <= 10 / 3600 for x in s), sum(x <= 60 / 3600 for x in s), max_snap,
                                         STAR_MAG_LIMIT, len(ls["faint"]), SNAP_DEG, n_unmatched))
    for hr in ls["faint"]:
        print("      line endpoint on BSC HR %d, V %.2f (not drawn as a star)" % (hr, all_stars[hr]["mag"]))
    for cid, ra, dec in ls["unmatched"]:
        print("      %s endpoint %.4f %.4f has no BSC star within %.1f deg" % (cid, ra, dec, SNAP_DEG))
    return {"unmatched_names": um}


def main(argv=None):
    ap = argparse.ArgumentParser(description="Build MarsSkyCatalog.txt from NASA HEASARC BSC5P, IAU-CSN and d3-celestial.")
    ap.add_argument("--bsc", required=True, help="NASA HEASARC heasarc_bsc5p.tdat(.gz)")
    ap.add_argument("--names", required=True, help="IAU-CSN.txt, the IAU WGSN Catalog of Star Names (text version)")
    ap.add_argument("--d3", required=True, help="directory with constellations.json, constellations.lines.json and "
                                                "LICENSE from d3-celestial's data/ folder")
    ap.add_argument("--out", required=True, help="output file, normally Assets/Mars/Resources/MarsSkyCatalog.txt")
    ap.add_argument("--list-unmatched", action="store_true", help="also print every IAU name not found in the BSC")
    args = ap.parse_args(argv)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="backslashreplace")   # a Windows console may not encode every name
    try:
        result = build(args.bsc, args.names, args.d3, args.out)
    except DataError as e:
        print("error: %s" % e, file=sys.stderr)
        return 1
    if args.list_unmatched:
        for e in result["unmatched_names"]:
            print("      not in BSC: %s (%s)" % (e["name"], e["designation"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
