(function () {

	var previewForm = document.getElementById('previewform');

	// --- FORK: preview PRIVATE repos by fetching through the authenticated GitHub API.
	// raw.githubusercontent.com does NOT accept a PAT (?token= is ignored, and its CORS
	// preflight rejects an Authorization header), so we cannot load private assets there.
	// api.github.com's contents endpoint IS CORS-enabled and accepts `Authorization`, so
	// we fetch the HTML + every asset through it with the token in a header. Images are
	// pulled as blobs and swapped in as object URLs. The token travels only as an HTTPS
	// header to api.github.com (never in an asset URL, never through a third-party proxy).

	var search = location.search.substring(1);                     // everything after the first ?
	var tokenMatch = search.match(/[?&]token=([^&#]+)/);
	var token = tokenMatch ? tokenMatch[1] : '';
	var target = search.replace(/[?&]token=[^&#]+/, '');           // target URL without the token

	// Parse owner / repo / ref / path from a github.com/blob/... or raw.githubusercontent/... URL
	var parse = function (u) {
		var m = u.match(/\/\/github\.com\/([^\/]+)\/([^\/]+)\/blob\/([^\/]+)\/([^?#]+)/);
		if (!m) m = u.match(/\/\/raw\.githubusercontent\.com\/([^\/]+)\/([^\/]+)\/(?:refs\/heads\/)?([^\/]+)\/([^?#]+)/);
		return m ? { owner: m[1], repo: m[2], ref: m[3], path: decodeURIComponent(m[4]) } : null;
	};
	var t = parse(target);

	// Base URL used ONLY to resolve relative asset paths to a repo path (never fetched itself)
	var rawBase = t ? 'https://raw.githubusercontent.com/' + t.owner + '/' + t.repo + '/' + t.ref + '/' + t.path : '';

	var apiUrl = function (path) {
		return 'https://api.github.com/repos/' + t.owner + '/' + t.repo + '/contents/' +
			path.split('/').map(encodeURIComponent).join('/') + '?ref=' + encodeURIComponent(t.ref);
	};
	var ghFetch = function (path) {
		return fetch(apiUrl(path), { headers: {
			'Authorization': 'token ' + token,
			'Accept': 'application/vnd.github.raw'
		} }).then(function (res) {
			if (!res.ok) throw new Error('Cannot load ' + path + ': ' + res.status + ' ' + res.statusText);
			return res;
		});
	};
	var ghText = function (path) { return ghFetch(path).then(function (r) { return r.text(); }); };

	// Resolve a repo path to its pre-signed raw download URL (a raw.githubusercontent.com
	// link with a short-lived ?token= for private repos). Loading images directly from
	// this URL avoids reading large binary bodies through fetch(), which Firefox truncates
	// on the raw-media redirect (NS_ERROR_NET_PARTIAL_TRANSFER / "Content-Length exceeds
	// response Body"). The PAT itself is never placed in an image URL.
	var ghDownloadUrl = function (path) {
		return fetch(apiUrl(path), { headers: {
			'Authorization': 'token ' + token,
			'Accept': 'application/vnd.github.object'
		} }).then(function (res) {
			if (!res.ok) throw new Error('Cannot resolve ' + path + ': ' + res.status + ' ' + res.statusText);
			return res.json();
		}).then(function (j) {
			if (!j.download_url) throw new Error('No download_url for ' + path);
			return j.download_url;
		});
	};

	// Absolute raw.githubusercontent URL (from <base> resolution) -> repo-relative path
	var rawToPath = function (u) {
		var m = u && u.match(/\/\/raw\.githubusercontent\.com\/[^\/]+\/[^\/]+\/(?:refs\/heads\/)?[^\/]+\/([^?#]+)/);
		return m ? decodeURIComponent(m[1]) : null;
	};

	// Small concurrency limiter so ~100 images don't fire ~100 simultaneous API calls
	// (which browsers -- Safari especially -- drop under load, leaving images broken).
	var MAX = 6, active = 0, waiting = [];
	var pump = function () {
		while (active < MAX && waiting.length) { active++; waiting.shift()().then(done, done); }
	};
	var done = function () { active--; pump(); };
	var enqueue = function (job) { waiting.push(job); pump(); };

	var withRetry = function (fn, n) {
		return fn().catch(function (e) {
			if (n <= 0) throw e;
			return new Promise(function (r) { setTimeout(r, 500); }).then(function () { return withRetry(fn, n - 1); });
		});
	};

	// Resolve one media element's stashed URL to an authenticated one and set it exactly
	// once. Because the src was neutralized in the HTML, the browser never fired a doomed
	// unauthenticated request first, so there is no broken-image flash to recover from.
	var loadMedia = function (el, dataAttr, targetAttr) {
		var orig = el.getAttribute(dataAttr);
		el.removeAttribute(dataAttr);
		var path = rawToPath(new URL(orig, rawBase).href);
		if (!path) { el[targetAttr] = orig; return; } // external / data: asset -> restore as-is
		var setFresh = function () { return ghDownloadUrl(path).then(function (url) { el[targetAttr] = url; }); };
		el.onerror = function () { el.onerror = null; setFresh().catch(function (e) { console.error(path, e); }); }; // one retry w/ fresh signed URL
		enqueue(function () { return withRetry(setFresh, 2).catch(function (e) { console.error(path, e); }); });
	};

	var replaceAssets = function () {
		var media, a, href, link, script, scripts = [], i, p;
		if (document.querySelectorAll('frameset').length) return;

		// Images / <source> / video posters (src/poster were stashed as data-* in the HTML)
		media = document.querySelectorAll('[data-hpsrc]');
		for (i = 0; i < media.length; ++i) loadMedia(media[i], 'data-hpsrc', 'src');
		media = document.querySelectorAll('[data-hpposter]');
		for (i = 0; i < media.length; ++i) loadMedia(media[i], 'data-hpposter', 'poster');

		// In-page anchors: the injected <base> would otherwise resolve "#foo" against the
		// raw file URL and navigate away (404). Re-point fragment links at this page's FULL
		// absolute URL so <base> can't touch them (a root-relative "/..." would still be
		// resolved against the base's origin). They then just scroll within the preview.
		a = document.querySelectorAll('a[href]');
		for (i = 0; i < a.length; ++i) {
			href = a[i].getAttribute('href');
			if (href && href.charAt(0) === '#') a[i].setAttribute('href', location.href.split('#')[0] + href);
		}

		// Stylesheets -> fetch text, inline as <style>
		link = document.querySelectorAll('link[rel=stylesheet]');
		for (i = 0; i < link.length; ++i) {
			p = rawToPath(link[i].href);
			if (p) ghText(p).then(loadCSS).catch(function (e) { console.error(e); });
		}

		// Scripts -> run in order (external fetched via API, inline kept as-is)
		script = document.querySelectorAll('script[type="text/htmlpreview"]');
		for (i = 0; i < script.length; ++i) {
			p = script[i].src ? rawToPath(script[i].src) : null;
			if (p) {
				scripts.push(ghText(p));
			} else {
				script[i].removeAttribute('type');
				scripts.push(script[i].innerHTML);
			}
		}
		Promise.all(scripts).then(function (res) {
			for (i = 0; i < res.length; ++i) loadJS(res[i]);
			document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
		}).catch(function (e) { console.error(e); });
	};

	var loadHTML = function (data) {
		if (!data) return;
		data = data.replace(/<head([^>]*)>/i, '<head$1><base href="' + rawBase + '">')
			// Stash media URLs in data-* so the browser does NOT fire an immediate
			// unauthenticated request (403 -> broken-image flash) before we swap in the
			// authenticated URL. loadMedia() sets the real src exactly once.
			.replace(/(<(?:img|source)\b[^>]*?\s)src=/gi, '$1data-hpsrc=')
			.replace(/(<video\b[^>]*?\s)poster=/gi, '$1data-hpposter=')
			.replace(/<script(\s*src=["'][^"']*["'])?(\s*type=["'](text|application)\/javascript["'])?/gi, '<script type="text/htmlpreview"$1');
		setTimeout(function () {
			document.open();
			document.write(data);
			document.close();
			replaceAssets();
		}, 10);
	};

	var loadCSS = function (data) {
		if (data) { var s = document.createElement('style'); s.innerHTML = data; document.head.appendChild(s); }
	};

	var loadJS = function (data) {
		if (data) { var s = document.createElement('script'); s.innerHTML = data; document.body.appendChild(s); }
	};

	if (t && token) {
		ghText(t.path).then(loadHTML).catch(function (error) {
			console.error(error);
			previewForm.style.display = 'block';
			previewForm.innerText = String(error);
		});
	} else {
		previewForm.style.display = 'block';
		if (target && !token) previewForm.innerText = 'Missing "?token=<your PAT>" at the end of the URL.';
		if (target && !t) previewForm.innerText = 'Could not parse a github.com/<owner>/<repo>/blob/<ref>/<path> URL.';
	}

})()
