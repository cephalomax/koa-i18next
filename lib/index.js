'use strict';

const debug = require('debug')('koa:i18next');

const DEFAULT_ORDER = ['querystring', 'cookie', 'header'];

const detectors = {
  cookie: function (context, options) {
    let cookie = options.lookupCookie || 'i18next';
    return context.cookies.get(cookie)
  },

  // fork from i18next-express-middleware
  header: function (context) {
    let acceptLanguage = context.get('accept-language');
    let found;
    let locales = [];
    if (acceptLanguage) {
      let lngs = [];

      // associate language tags by their 'q' value (between 1 and 0)
      acceptLanguage.split(',').forEach(function (l) {
        let parts = l.split(';'); // 'en-GB;q=0.8' -> ['en-GB', 'q=0.8']

        // get the language tag qvalue: 'q=0.8' -> 0.8
        let qvalue = 1; // default qvalue

        for (let i = 0; i < parts.length; i++) {
          let part = parts[i].split('=');
          if (part[0] === 'q' && !isNaN(part[1])) {
            qvalue = Number(part[1]);
            break
          }
        }
        // add the tag and primary subtag to the qvalue associations
        lngs.push({
          lng: parts[0],
          q: qvalue
        });
      });

      lngs.sort(function (a, b) {
        return b.q - a.q
      });

      for (let i = 0; i < lngs.length; i++) {
        locales.push(lngs[i].lng);
      }

      if (locales.length) found = locales;
    }

    return found
  },
  path: function (context, options) {
    let found;

    if (options.lookupPath !== undefined && context.params) {
      found = context.params[options.lookupPath];
    }

    if (!found && options.lookupFromPathIndex !== undefined) {
      let parts = context.path.split('/');
      if (parts[0] === '') { // Handle paths that start with a slash, i.e., '/foo' -> ['', 'foo']
        parts.shift();
      }

      if (parts.length > options.lookupFromPathIndex) {
        found = parts[options.lookupFromPathIndex];
      }
    }
    return found
  },
  querystring: function (context, options) {
    let name = options.lookupQuerystring || 'lng';
    return context.query[name]
  },

  session: function (context, options) {
    let name = options.lookupSession || 'lng';
    return context.session && context.session[name]
  }
};

function detect (context, options = {}) {
  let { order, fallback } = options;
  order = order && Array.isArray(order)
    ? order
    : DEFAULT_ORDER;

  let lngs = [];

  for (let i = 0, len = order.length; i < len; i++) {
    let detector = detectors[order[i]];
    let lng;
    if (detector) {
      lng = detector(context, options);
    }
    if (lng && typeof lng === 'string') {
      lngs.push(lng);
    } else {
      lngs = lngs.concat(lng);
    }
  }
  let found;
  for (let i = 0, len = lngs.length; i < len; i++) {
    let cleanedLng = context.i18next.services.languageUtils.formatLanguageCode(lngs[i]);
    if (context.i18next.services.languageUtils.isWhitelisted(cleanedLng)) found = cleanedLng;
    if (found) break
  }

  return found || fallback
}

const debug$1 = require('debug')('koa:i18next');

function koaI18next(i18next, options = {}) {

  return async function i18nextMiddleware(ctx, next) {
    ctx.i18next = i18next;

    let lng = detect(ctx, options);
    lng && setLanguage(ctx, lng, options);

    debug$1('language is', lng);

    ctx.t = function (...args) {
      // do detect path
      if (!lng && isDetectPath(options.order)) {
        lng = detect(ctx, Object.assign(options, { order: ['path'] }));
        lng && setLanguage(ctx, lng, options);
      }

      if (args.length === 1) {
        args.push({});
      }

      for (let i = 0, len = args.length; i < len; i++) {
        let arg = args[i];
        if (typeof arg === 'object' && !Array.isArray(arg)) {
          arg.lng = lng;
        }
      }
      return i18next.t.apply(i18next, args)
    };

    await next();
  }
}


function setPath(object, path, newValue) {
  let stack;
  if (typeof path !== "string") stack = [].concat(path);
  if (typeof path === "string") stack = path.split(".");

  while (stack.length > 1) {
    let key = stack.shift();
    if (key.indexOf("###") > -1) key = key.replace(/###/g, ".");
    if (!object[key]) object[key] = {};
    object = object[key];
  }

  let key = stack.shift();
  if (key.indexOf("###") > -1) key = key.replace(/###/g, ".");
  object[key] = newValue;
}

koaI18next.getResourcesHandler = function (i18next, options) {
  options = options || {};
  let maxAge = options.maxAge || 60 * 60 * 24 * 30;
  const propertyParam = options.propertyParam || 'query';

  return async function (ctx, next) {
    if (options.path && ctx.path !== options.path) {
      return await next();
    }
    if (!i18next.services.backendConnector) return ctx.throw(404, "koa-i18next-middleware:: no backend configured");

    let resources = {};

    ctx.type = "json";
    if (options.cache !== undefined ? options.cache : process.env.NODE_ENV === "production") {
      ctx.set("Cache-Control", "public, max-age=" + maxAge);
      ctx.set("Expires", new Date(new Date().getTime() + maxAge * 1000).toUTCString());
    } else {
      ctx.set("Pragma", "no-cache");
      ctx.set("Cache-Control", "no-cache");
    }

    let languages = ctx[propertyParam][options.lngParam || "lng"] ? ctx[propertyParam][options.lngParam || "lng"].split(" ") : [];
    let namespaces = ctx[propertyParam][options.nsParam || "ns"] ? ctx[propertyParam][options.nsParam || "ns"].split(" ") : [];

    // extend ns
    namespaces.forEach(ns => {
      if (i18next.options.ns && i18next.options.ns.indexOf(ns) < 0) i18next.options.ns.push(ns);
    });

    i18next.services.backendConnector.load(languages, namespaces, function () {
      languages.forEach(lng => {
        namespaces.forEach(ns => {
          setPath(resources, [lng, ns], i18next.getResourceBundle(lng, ns));
        });
      });
      ctx.body = resources;
    });
  };
};

koaI18next.getMissingKeyHandler = function (i18next, options) {
  options = options || {};
  const propertyParam = options.propertyParam || 'query';

  return async function (ctx, next) {
    if (options.path && ctx.path !== options.path) {
      return await next();
    }
    let lng = ctx[propertyParam][options.lngParam || "lng"];
    let ns = ctx[propertyParam][options.nsParam || "ns"];

    if (!i18next.services.backendConnector) return ctx.throw(404, "koa-i18next-middleware:: no backend configured");

    for (var m in ctx.request.body) {
      i18next.services.backendConnector.saveMissing([lng], ns, m, ctx.request.body[m]);
    }
    ctx.body = "ok";
  };
};

function isDetectPath(order = []) {
  return order.indexOf('path') !== -1
}

function setLanguage(context, lng, options = {}) {
  const {
    lookupCookie
    , lookupCookieDomain
    , lookupPath
    , lookupSession
  } = options;
  context.locals = Object.assign(context.locals || {}, { lng });
  context.state = Object.assign(context.state || {}, { lng });
  context.language = context.lng = lng;
  context.set('content-language', lng);
  if (lookupCookie) {
    context.cookies.set(lookupCookie, lng, { httpOnly: false, signed: false, domain: lookupCookieDomain });
  }
  if (lookupSession && context.session) {
    context.session[lookupSession] = lng;
  }
}

module.exports = koaI18next;
//# sourceMappingURL=index.js.map
