test:
	mocha

example:
	@cat example.html | node index.js	

cv:
	@cat cv.html | node index.js	

.PHONY: test
