var htmlparser = require('htmlparser2');
var escodegen = require('escodegen')
var b = require('ast-types').builders;
var n = require("ast-types").namedTypes;
//var bunyan = require('bunyan');
//var log = bunyan.createLogger({name: "tmplify"});

var log = {
	debug: function (msg) {
		// console.log(arguments.callee.caller.name 
		// 	+ "(" + arguments.callee.caller.caller.name + ")", msg)
	}
}

var handler = new htmlparser.DomHandler(htmlParseDone);

var parser = new htmlparser.Parser(handler);
process.stdin.pipe(parser);

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
	if (node.attribs && typeof node.attribs['if'] != 'undefined') {
		return {
			type: 'if',
			test: node.attribs['if'],
			consequent: node
		}
	} else {
		//console.log('ATTRS', node.attribs)
	}
	return node
}

function visitTemplateRoot (node, parentNode) {
	if (node.type != 'tag') {
		throw new Error('Top level should be a tag');
	}

	node = traverseDepthFirst(node, ifTransform)
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
						b.identifier("main"),
						[b.identifier("model")],
						b.blockStatement([							// = function main (model) { 
							declareEmptyArray('buffer'), 	// 		var buffer = [];
							entryStatement(entry),				// 		entryFn(model, buffer)
							b.returnStatement(
								b.callExpression(
									b.memberExpression(
										b.identifier("buffer"),
										b.identifier("join"),
										false
									),
									[b.literal("")]						// 		return buffer.join("")
								)
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
			b.callExpression(
				b.identifier(entry.id.name),
				[b.identifier('model'), b.identifier('buffer')]
			)
		)	
	}

	if (entry.type == 'IfStatement') {
		return entry
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
		default:
			throw new Error('unknown type', node)
	}
}

function visitIf(node) {
	var cons = visit(node.consequent)
	var consBlock = cons[cons.length-1]

	var body = consBlock.body.body
	consBlock.body.body = [b.ifStatement(
			b.identifier(node.test),
			b.blockStatement(body)
		)
	]

	var declarations = functionDeclarations(cons)

	return declarations
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
	var topLevel = children.map(last)
	var declarations = flatten(children).filter(function (t) {
			return t.type === 'FunctionDeclaration' })
	
	var body = topLevel.filter(defined).map(output)

	return declarations.concat([
		b.functionDeclaration(
			b.identifier(namer.name(tag)),
			[ b.identifier('model'), b.identifier('buffer') ],
			b.blockStatement(
				startTag(tag).concat(body).concat(endTag(tag))
			)
		)
	])
}

function visitText(tag) {
	return [b.literal(tag.data)]
}

function output(node) {
	if (!node.type) {
		console.log(node)
	}

	switch (node.type) {
		case 'FunctionDeclaration':
			return call(node)
			break;
		case 'Literal':
			return concatBuffer(node)
			break;
		default:
			throw new Error('Unknown output type: ' + JSON.stringify(node))
	}
}

function call (functionDeclaration) {
	log.debug(functionDeclaration)

	return  b.expressionStatement(
						b.callExpression(
					 		b.identifier(functionDeclaration.id.name),
							[b.identifier('model'), b.identifier('buffer')]
						)
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

function startTag(tag) {
	return  outputAll.apply(null,
					[			
						'<' + tag.name,
						'>'
					].map(b.literal))
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
}

FunctionNamer.prototype.name = function (node) {
	return this['name_' + node.type].call(this, node)
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
	return !this.names.hasOwnProperty(name)
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
	return index(-1)(arr)
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