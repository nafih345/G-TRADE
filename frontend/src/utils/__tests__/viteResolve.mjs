// Node's test runner + the app's Vite-style imports: `import x from './notify'` (no extension).
// Loaded with --import; resolves an extensionless relative import to its .js / .jsx file.
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (err) {
      if (err?.code !== 'ERR_MODULE_NOT_FOUND' || !/^\.{1,2}\//.test(specifier) || /\.[cm]?jsx?$/.test(specifier)) throw err;
      return next(`${specifier}.js`, context);
    }
  },
});
