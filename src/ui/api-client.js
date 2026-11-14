/** Same-origin Adi API adapter. No mock fallback on failed requests. */
export function createApiClient(fetcher = fetch) {
  let latestRequest = null;
  async function request(path, options = {}) {
    let response;
    try { response = await fetcher(path, {...options, signal: AbortSignal.timeout(15000)}); }
    catch { throw Object.assign(new Error('Cannot reach the API. Run the combined Node server.'), {code:'NETWORK_ERROR'}); }
    let body;
    try { body = await response.json(); }
    catch { throw Object.assign(new Error('API did not return JSON. Use the combined server, not the old static preview.'), {code:'INVALID_RESPONSE'}); }
    if (!response.ok) throw Object.assign(new Error(body.error?.message || 'Request failed'), {code:body.error?.code || `HTTP_${response.status}`,status:response.status});
    return body;
  }
  return {
    getConfig:()=>request('/api/config'),
    getRegion:()=>request('/api/region'),
    async planRoutes(input) {
      latestRequest=input.requestId;
      const result=await request('/api/routes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
      if(latestRequest!==input.requestId)return null;
      if(result.requestId!==input.requestId||result.dataVersion!==input.dataVersion)throw Object.assign(new Error('Stale route response. Reload region and retry.'),{code:'STALE_RESULT'});
      return result;
    }
  };
}
