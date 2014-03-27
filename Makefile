test:
	mocha

example:
	cat example.html | node index.js	

cv:
	cat cv.html | node index.js

browser: browser.js

browser.js: app.js index.js
	browserify app.js -o browser.js

.PHONY: test
