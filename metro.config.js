const { getDefaultConfig } = require('expo/metro-config');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// expo-sqlite uses a WASM worker on web.
config.resolver.assetExts.push('wasm');

// SharedArrayBuffer requires cross-origin isolation in the browser.
config.server.enhanceMiddleware = (middleware) => {
  return (request, response, next) => {
    response.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    return middleware(request, response, next);
  };
};

module.exports = config;
