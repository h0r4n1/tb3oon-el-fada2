import json
import pathlib
import requests

out= pathlib.Path(__file__).resolve().parent.parent / "data"
out.mkdir(exist_ok=True)




base="https://mars.nasa.gov/mmgis-maps/M20/Layers/json/"

candidates= {
    "rover_path" : "M20_traverse.json",
    "waypoints" : "M20_waypoints.json", 
}

for name, filename in candidates.items():
    url= base + filename
    print(f"\nTrying {url}")
    try:

        r=requests.get(url, timeout= 30)
    except requests.RequestException as e:
        print(f" request failed: {e}")
        continue


    print(f" status {r.status_code}, {len(r.content)/1024:.1f} kB")
    if r.status_code != 200:
        continue
    try:
        data= r.json()
    except ValueError:
        print(" not JSON, probably an error page.")
        continue


    destination_var= out / f"{name}.geojson"
    destination_var.write_text(json.dumps(data), encoding="utf-8")
    featurr= data.get("features", [])
    print(f" saved {destination_var.name} with {len(featurr)} features")
    if featurr:
        print(f" first featur properties: {list(featurr[0].get('properties', {}))}")  
