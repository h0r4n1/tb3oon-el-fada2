
export function isInsideRegion(point, region) {
  if (!point || !region?.bounds) return false;

  const { lat, lon } = point;
  const { south, west, north, east } = region.bounds;

  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= south &&
    lat <= north &&
    lon >= west &&
    lon <= east
  );
}

// GeoJSON: [longitude, latitude]
// Leaflet: [latitude, longitude]
export function geoJsonToLeaflet(coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length < 2) {
    throw new Error("Invalid GeoJSON coordinate.");
  }

  const [lon, lat] = coordinates;

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error("Invalid coordinate values.");
  }

  return [lat, lon];
}
