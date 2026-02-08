import { app } from './lib/agent';

const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;

console.log(`Starting agent server on port ${port}...`);

// Fix for Railway/reverse proxy: rewrite request URL to use HTTPS when behind proxy
// The x402 payment middleware uses request.url directly, which is HTTP internally
const proxyFixFetch = async (request: Request): Promise<Response> => {
  const forwardedProto = request.headers.get('x-forwarded-proto');
  const forwardedHost = request.headers.get('x-forwarded-host');
  
  let fixedRequest = request;
  
  // If behind a reverse proxy (Railway, etc.), fix the URL to use HTTPS
  if (forwardedProto === 'https' || forwardedHost) {
    const originalUrl = new URL(request.url);
    const fixedUrl = new URL(request.url);
    
    if (forwardedProto) {
      fixedUrl.protocol = forwardedProto + ':';
    }
    if (forwardedHost) {
      fixedUrl.host = forwardedHost;
    }
    
    // Only create new request if URL actually changed
    if (fixedUrl.href !== originalUrl.href) {
      fixedRequest = new Request(fixedUrl.href, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        // @ts-ignore - duplex is needed for streaming bodies
        duplex: 'half',
      });
      console.log(`[PROXY] Rewrote URL: ${originalUrl.protocol}//${originalUrl.host} → ${fixedUrl.protocol}//${fixedUrl.host}`);
    }
  }
  
  const url = new URL(fixedRequest.url);
  
  console.log(`[REQ] ${fixedRequest.method} ${url.pathname}`);
  
  // Log ALL headers
  const allHeaders: string[] = [];
  fixedRequest.headers.forEach((value, key) => {
    allHeaders.push(`${key}: ${value.slice(0, 50)}${value.length > 50 ? '...' : ''}`);
  });
  console.log(`[REQ] Headers: ${allHeaders.join(', ')}`);
  
  const response = await app.fetch(fixedRequest);
  
  console.log(`[RES] ${response.status} ${url.pathname}`);
  if (response.status === 402) {
    const paymentRequired = response.headers.get('PAYMENT-REQUIRED');
    if (paymentRequired) {
      console.log(`[RES] Payment-Required header present`);
    }
  }
  
  return response;
};

export default {
  port,
  fetch: proxyFixFetch,
};
