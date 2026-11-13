import sys
import json
import pathlib
datA= pathlib.Path(__file__).resolve().parent.parent / "data"

raw= json.loads( (datA / "waypoints.geojson").read_text(encoding="utf-8") )
features= raw["features"]
print(f"loaded {len(features)} waypoints")
keep=["sol", "site", "drive", "lat", "lon", "elev_geoid", "dist_total_m", "Note"]

slim= []
lats, lons, elevs= [], [], []




for i in features:
    p= i["properties"]
    slim.append({
        "type": "Feature",
        "geometry": i["geometry"],
        "properties": {k: p.get(k) for k in keep},
    })

    if p.get("lat") is not None:
        lats.append(p["lat"])
        lons.append(p["lon"])
    if p.get("elev_geoid") is not None:
        elevs.append(p["elev_geoid"])


Destinations= datA / "waypoints_slims.geojson"
Destinations.write_text(json.dumps({"type": "FeatureCollection", "features": slim}), encoding="utf-8")






before= (datA / "waypoints.geojson").stat().st_size / 1024
after= Destinations.stat().st_size / 1024
print(f"saved {Destinations.name}: {before:.0f} kB -> {after:.0f} kB")

print("\n   Bounding Box (for the DEM crop: )   ")
print(f"lat: {min(lats):.5f} to {max(lats):.5f}")
print(f"lon: {min(lons):.5f} to {max(lons):.5f}")
print(f"elevation: {min(elevs):.1f} to {max(elevs):.1f} m")

distances= [f["properties"]["distance_total_m"] for f in slim if f["properties"]["distance_total_m"]]
print(f"total traverse: {max(distances)/1000:.2f} km")