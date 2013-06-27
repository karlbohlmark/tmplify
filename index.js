var htmlparser = require('htmlparser2');
var escodegen = require('escodegen')
var b = require('ast-types').builders;
var n = require("ast-types").namedTypes;
var resumer = require('resumer');
//var bunyan = require('bunyan');
//var log = bunyan.createLogger({name: "tmplify"});

module.exports = compile

var log = {
	debug: function (msg) {
		// console.log(arguments.callee.caller.name 
		// 	+ "(" + arguments.callee.caller.caller.name + ")", msg)
	}
}

var handler = new htmlparser.DomHandler(htmlParseDone);

var parser = new htmlparser.Parser(handler);

var scopeChain = new ScopeChain()

if (!module.parent) {
	compile(process.stdin)
}


function ScopeChain() {
	this.scopes = ['model']
}

ScopeChain.prototype.enter = function (scope) {
	this.scopes.unshift(scope)
}

ScopeChain.prototype.exit = function (scope) {
	this.scopes.shift()
}

ScopeChain.prototype.contains = function (name) {
	return this.scopes.indexOf(name) != -1
}

ScopeChain.prototype.map = function (f) {
	return this.scopes.map(f)
}


function toStream(stringOrStream) {
	if ("string" == typeof stringOrStream) {
		return resumer().queue(stringOrStream).end()
	}
	return stringOrStream
}


function compile(readable) {
	toStream(readable).pipe(parser);
}


var namer = new FunctionNamer()

function htmlParseDone (err, dom) {
		if (err) throw err;


		toTemplateDOM(dom);
}


function toTemplateDOM(dom) {
	var tmpl = {};

	visitTemplateRoot(dom.shift(), tmpl);
}


function traverseDepthFirst (tree, fn) {
	tree.children = tree.children && tree.children.map(function (child) {
		return traverseDepthFirst(child, fn)
	})
	return fn(tree)
}


function ifTransform (node) {
	var attrs = node.attribs
	var test = attrs && typeof attrs['if'] != 'undefined' && attrs['if']
	if (test) {
		delete attrs['if']
		return {
			type: 'if',
			test: test,
			children: [node]
		}
	} else {
		//console.log('ATTRS', node.attribs)
	}
	return node
}


function eachTransform (node) {
	var attrs = node.attribs
	var each = attrs && attrs.each
	if (each) {
		delete attrs.each
		var parts = each.split(' ')
		return {
			type: 'each',
			loopVar: parts.shift(),
			enumerable: parts.pop(),
			children: [node]
		}
	} else {
		//console.log('ATTRS', node.attribs)
	}
	return node
}


function textTransform (node) {
	var attrs = node.attribs
	var text = attrs && attrs.text
	if (text) {
		delete attrs.text
		node.children = [{
			type: 'text',
			data: interpolationFormat(text)
		}]
	} else {
		//console.log('ATTRS', node.attribs)
	}
	return node
}


function interpolationFormat(identifier) {
	return "${" + identifier + "}"
}


function visitTemplateRoot (node, parentNode) {
	if (node.type != 'tag') {
		throw new Error('Top level should be a tag');
	}

	node = traverseDepthFirst(node, ifTransform)
	node = traverseDepthFirst(node, eachTransform)
	node = traverseDepthFirst(node, textTransform)

	//console.log(require('util').inspect(node.children, {depth:5}))
	//traverseDepthFirst(node, eachTransform)

	var body = visit(node);
	
	var bufferInit = b.variableDeclaration('var', [
		b.variableDeclarator(
			b.identifier('buffer'),
			b.literal("")
		)
	])

	var entry = body[body.length-1]

	//console.log('ENTRY', body[body.length-1])
	var fnDeclarations = functionDeclarations(body);

	var program = b.program(
			concat(
				fnDeclarations,					// function myPartial1..N (model, buffer) {...}
				singleExport(												// module.exports =
					b.functionExpression(
						b.identifier(""),
						[b.identifier("model")],
						b.blockStatement([							// = function main (model) { 
							declareEmptyBuffer(), 	// 		var buffer = "";
							entryStatement(entry),				// 		entryFn(model, buffer)
							b.returnStatement(
								b.identifier("buffer")
							)
						])
					)
				)
			)
	)

	console.log(escodegen.generate(program));
}


function entryStatement(entry) {
	if (entry.type == 'FunctionDeclaration') {
		return b.expressionStatement(
			b.assignmentExpression('+=',
				b.identifier('buffer'),
				b.callExpression(
					b.identifier(entry.id.name),
					[b.identifier('model')]
				)
			)
		)
	}

	if (entry.type == 'IfStatement') {
		return entry
	}

	if (entry.type == 'CallExpression') {
		return b.expressionStatement(entry)
	}
}

function visit(node) {
	switch (node.type) {
		case 'tag':
			return visitTag(node)
			break;
		case 'text':
			return visitText(node)
			break;
		case 'if':
			return visitIf(node)
		case 'each':
			return visitEach(node)
		default:
			throw new Error('unknown type', node)
	}
}

function visitIf(node) {
	var children = node.children && node.children.map(visit) || []
	var topLevel = children.map(last)
	var declarations = flatten(children).filter(function (t) {
			return t.type === 'FunctionDeclaration' })
		
	var body = topLevel.filter(defined).map(output)

	return declarations.concat([
		b.ifStatement(
			b.identifier(node.test),
			b.blockStatement(
					body
			)
		)
	])
}

function visitEach(node) {
	var enumerable = resolve(node.enumerable)
	var loopVar = loopVarParamName(node.loopVar)
	scopeChain.enter(loopVar)
	var children = node.children.map(visit)

	var declarations = flatten(children).filter(function (t) {
			return t.type === 'FunctionDeclaration' })
	var topLevel = children.map(last)
	var result = concat(
		declarations,
		b.callExpression(
			b.memberExpression(
				b.identifier(enumerable),
				b.identifier('reduce'),
				false
			),
			[
				b.functionExpression(
						b.identifier(""),
						[b.identifier('buffer'), b.identifier(loopVar)],
						b.blockStatement(concat(
							topLevel.map(output),
							b.returnStatement(
								b.identifier('buffer')
							)
						))
				),
				b.literal("")
			]
		)
	)

	scopeChain.exit(loopVar)
	return result
}

function loopVarParamName(name) {
	while(!namer.isAvailable(name) || scopeChain.contains(name)) {
		name = '_' + name
	}
	return name
}

function resolve(name) {
	var parts = name.split('.')
	var nameInScope = parts.shift()
	if (!scopeChain.contains(nameInScope)) {
		//console.log('SCOPES', scopes, nameInScope)
		return 'model.' + name
	} else {
		return name
	}
}

function functionDeclarations(arr) {
	return arr.filter(function (item) {
		return item.type == 'FunctionDeclaration'
	})
}

function visitTag(tag) {
	log.debug(tag)

	if (!tag.name) {
		throw new Error('Tags should have a name. Tag: ' + Object.keys(tag).join(''))
	}

	var children = tag.children && tag.children.map(visit) || []

	var topLevel = children.map(function (c) {
		return c[c.length-1]
	})
	var declarations = flatten(children).filter(function (t) {
			return t.type === 'FunctionDeclaration' })
	
	var body = topLevel.filter(defined).map(output)

	//console.log('-- BODY --', tag.name)
	//console.log(body)

	return declarations.concat([
		b.functionDeclaration(
			b.identifier(namer.name(tag)),
			scopeChain.map(b.identifier),
			b.blockStatement(
				concat(
					declareEmptyBuffer(),
					startTag(tag),
					body,
					endTag(tag),
					returnBuffer()
				)
			)
		)
	])
}

function declareEmptyBuffer() {
	return b.variableDeclaration('var', [
		b.variableDeclarator(
			b.identifier('buffer'),
			b.literal("")
		)
	])
}

function returnBuffer() {
	return b.returnStatement(
		b.identifier('buffer')
	)
}

function visitText(tag) {
	var i = interpolate(tag.data)
	return [interpolate(tag.data)]//[b.literal(tag.data)]
}

function visitAttr(attr) {
	var res = [b.literal(' ' + attr.key)]
	var val = attr.value
	if (typeof val != 'undefined') {
		res.push(b.literal('='))
		res.push(b.literal("\""))
		
		interpolateSplit(val).forEach(function (literalOrIdentifier) {
			res.push(literalOrIdentifier)
		})

		res.push(b.literal("\""))
	}

	return res
}

function output(node) {
	if (!node.type) {
		console.log(node)
	}

	switch (node.type) {
		case 'FunctionDeclaration':
			return concatBuffer( call(node) )
			break;
		case 'Literal':
			return concatBuffer(node)
			break;
		case 'Identifier':
			return concatBuffer(node)
			break;
		case 'IfStatement':
			return node
			break;
		case 'BlockStatement':
			return node
			break;
		case 'CallExpression':
			return concatBuffer(node)
			break;
		default:
			throw new Error('Unknown output type: ' + JSON.stringify(node))
	}
}

function call (functionDeclaration) {
	log.debug(functionDeclaration)

	return 	b.callExpression(
				 		b.identifier(functionDeclaration.id.name),
						scopeChain.map(b.identifier)
					)
					
}

function concatBuffer(node) {
	return  b.expressionStatement(
						b.assignmentExpression(
							'+=',	
							b.identifier('buffer'),
							node
						)
					)
}

/**
 * @return {Statement}
 */
function interpolate(text) {
	var pieces = interpolateSplit(text)
	return b.blockStatement(pieces.map(output));
}

function interpolateSplit(text) {
	var interpolationPattern = /\$\{([^\}]*)\}/
	var index, pieces = []
	if (interpolationPattern.test(text)) {
		while(match = interpolationPattern.exec(text)) {
			index = text.indexOf(match[0])
			if (index) {
				pieces.push(b.literal(text.substring(0, index)))
			}

			pieces.push(b.identifier(resolve(match[1])))
			text = text.slice(index + match[0].length)
		}
		if (text.length > 0) {
			pieces.push(b.literal(text))
		}
	} else {
		pieces.push(b.literal(text))
	}
	return pieces
}

function startTag(tag) {
	var out = [b.literal('<' + tag.name)]
	tag.attribs && Object.keys(tag.attribs).forEach(function (key) {
		//console.log('OUT', key, tag.attribs[key])
		visitAttr({key: key, value: tag.attribs[key]}).map(function (aa) {
			out.push(aa)
		})
	})
	out.push(b.literal('>'))
	return outputAll.apply(null, out)
}

function outputAll () {
	var theThings = [].slice.call(arguments)
	return flatten(theThings).map(concatBuffer)
}

function endTag(tag) {
	return  [
						concatBuffer(
							b.literal('</' + tag.name + '>')
						)
					]
}

function declareEmptyArray(varName) {
	return b.variableDeclaration('var', [
		b.variableDeclarator(
			b.identifier(varName),
			b.arrayExpression([])
		)
	])
}

function singleExport(expression) {
	return b.expressionStatement(
		b.assignmentExpression('=',
			b.memberExpression(
				b.identifier('module'),
				b.identifier('exports'),
				false
			),
			expression
		)
	)
}


function FunctionNamer() {
	this.names = {}
	this.aliases = {}
}

FunctionNamer.prototype.name = function (node) {
	var name = this['name_' + node.type].call(this, node)
	if (node.attribs && node.attribs.exports) {
		if (name in this.names.aliases) {
			throw new Error('Duplicate export name ' + node.attribs.exports)
		}
		this.names.aliases[name] = node.attribs.exports
	}
	return name
}

FunctionNamer.prototype.firstAvailable = function () {
	var strategies = arguments
	return function (node) {
		var strategy, name
		for (var i=0; i<strategies.length; i++) {
			strategy = strategies[i]
			name = strategy(node)
			if (!name) continue
			if (this.isAvailable(name)) {
				this.registerName(name, node)
				return name
			}
		}

		throw new Error('No available name found for node of type' + node.type)
	}.bind(this)
}

FunctionNamer.prototype.registerName = function (name,node) {
	this.names[name] = node
}

FunctionNamer.prototype.name_tag = function (node) {
	return this.firstAvailable(
			this.byClassName,
			this.byTagName,
			this.disambiguateByCounter(this.byTagName)
	)(node)
}

FunctionNamer.prototype.name_each = function (node) {
	return this.firstAvailable(
			this.byTagName,
			this.disambiguateByCounter(this.byTagName))
}

FunctionNamer.prototype.disambiguateByCounter = function (strategy) {
	var i = 0
	var candidate
	return function (node) {
		var name = strategy(node)
		while (!this.isAvailable(candidate = name + '_' + i++))
			;
		return candidate;
	}.bind(this)
}

FunctionNamer.prototype.isAvailable = function (name) {
	return !this.names.hasOwnProperty(name) && !scopeChain.contains(name)
}

FunctionNamer.prototype.byTagName = function (node) {
	return node.name
}

FunctionNamer.prototype.byClassName = function (node) {
	var cls = node.attribs && node.attribs['class']
	return cls && cls.split(' ').map(identifierify).join('_')
}

FunctionNamer.prototype.byLoopVar = function (eachNode) {
	return eachNode.loopVar
}

function identifierify(str) {
	return str.replace('-', '_')
}


function last(arr) {
	return arr[arr.length-1]
}

function index(i) {
	return function (arr) {
		if (i < 0) {
			i = Math.abs(arr.length - i) % arr.length;
		}
		return arr[i]
	}
}

function arrayWrap(item) {
	if (Array.isArray(item)) {
		return item;
	}
	return [item]
}

function concat(maybeArrsMaybeNot) {
	var args = [].slice.call(arguments)
	return args.reduce(function (acc, cur) {
		arrayWrap(cur).forEach(function (item) {
				acc.push(item)
		})
		return acc
	}, [])
}

function flatten(arr) {
	return arr.reduce(function (acc, cur) {
		return acc.concat(cur)
	}, [])
}

function defined(item) {
	return typeof item !== "undefined"
}