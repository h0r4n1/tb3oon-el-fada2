import json, pathlib
from collections import Counter
DATA = pathlib.Path(__file__).resolve().parent.parent / "data"
ELEV_INVALID_ABOVE = -100.0





rp = json.loads((DATA / "rover_path_2d.geojson").read_text(encoding="utf-8"))
bad_total, affected = 0, []
for i, f in enumerate(rp["features"]):
    elevs = f["properties"].get("elevations") or []
    idx = [j for j, z in enumerate(elevs) if z is not None and z > ELEV_INVALID_ABOVE]
    if idx:
        p = f["properties"]
        affected.append((i, p.get("sol"), p.get("fromRMC"), p.get("toRMC"),
                         len(idx), len(elevs), sorted({elevs[j] for j in idx})))
        for j in idx:
            elevs[j] = None
        bad_total += len(idx)

print(f"ELEVATIONS: nulled {bad_total} vertices across {len(affected)} feature(s)")


for a in affected:
    print(f"  feature {a[0]}: sol={a[1]} fromRMC={a[2]} toRMC={a[3]} "
          f"{a[4]}/{a[5]} vertices, values={a[6]}")

valid = [z for f in rp["features"] for z in (f["properties"].get("elevations") or [])
         if z is not None]
print(f"  remaining range: {min(valid):.1f} to {max(valid):.1f} m "
      f"({len(valid)} valid, {bad_total} null)")





wp = json.loads((DATA / "waypoints_2d.geojson").read_text(encoding="utf-8"))

print("\nNOTE vs dist_total_m == 0:")
cross = Counter()
for f in wp["features"]:
    p = f["properties"]
    cross[(p.get("Note"), p.get("dist_total_m") == 0)] += 1
for (note, is_zero), n in sorted(cross.items(), key=lambda x: str(x[0])):
    print(f"  Note={note!r:<20} zero={is_zero}  count={n}")





start = min(wp["features"], key=lambda f: f["properties"]["sol"])
sp = start["properties"]
print(f"\n  start waypoint: sol={sp['sol']} Note={sp.get('Note')!r} "
      f"dist_total_m={sp.get('dist_total_m')}")





NULL_NOTES = {"Mid-drive localization", "Interpolated"}
nulled = 0
for f in wp["features"]:
    p = f["properties"]
    if p.get("Note") in NULL_NOTES and p.get("dist_total_m") == 0:
        p["dist_total_m"] = None
        nulled += 1
print(f"  nulled dist_total_m on {nulled} waypoints (Note in {sorted(NULL_NOTES)})")
still_zero = [f["properties"]["sol"] for f in wp["features"]
              if f["properties"].get("dist_total_m") == 0]
print(f"  waypoints still at exactly 0: sols {still_zero}")





(DATA / "rover_path_2d.geojson").write_text(json.dumps(rp), encoding="utf-8")
(DATA / "waypoints_2d.geojson").write_text(json.dumps(wp), encoding="utf-8")
print("\nwritten: rover_path_2d.geojson, waypoints_2d.geojson")
