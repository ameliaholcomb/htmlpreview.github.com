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

	var mime = function (path) {
		var ext = (path.split('.').pop() || '').toLowerCase();
		return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
			svg: 'image/svg+xml', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon',
			css: 'text/css', js: 'application/javascript', json: 'application/json',
			html: 'text/html', htm: 'text/html' })[ext] || 'application/octet-stream';
	};

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
	var ghObjectURL = function (path) {
		return ghFetch(path).then(function (r) { return r.arrayBuffer(); }).then(function (buf) {
			return URL.createObjectURL(new Blob([buf], { type: mime(path) }));
		});
	};

	// Absolute raw.githubusercontent URL (from <base> resolution) -> repo-relative path
	var rawToPath = function (u) {
		var m = u && u.match(/\/\/raw\.githubusercontent\.com\/[^\/]+\/[^\/]+\/(?:refs\/heads\/)?[^\/]+\/([^?#]+)/);
		return m ? decodeURIComponent(m[1]) : null;
	};

	var replaceAssets = function () {
		var img, link, script, scripts = [], i, p;
		if (document.querySelectorAll('frameset').length) return;

		// Images / <source> / video posters -> fetch as blob via API, swap in object URL
		img = document.querySelectorAll('img[src],source[src],video[poster]');
		for (i = 0; i < img.length; ++i) (function (el) {
			['src', 'poster'].forEach(function (attr) {
				if (!el.getAttribute(attr)) return;
				var path = rawToPath(el[attr]);            // el[attr] is absolute (resolved via <base>)
				if (!path) return;                          // external / non-repo asset: leave as-is
				ghObjectURL(path).then(function (obj) { el[attr] = obj; })
					.catch(function (e) { console.error(e); });
			});
		})(img[i]);

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
