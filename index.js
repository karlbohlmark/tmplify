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

function htmlParseDone (err, dom) {
		if (err) throw err;


		toTemplateDOM(dom);
}

function toTemplateDOM(dom) {
	var tmpl = {};

	visitTemplateRoot(dom.shift(), tmpl);
}

function visitTemplateRoot (node, parentNode) {
	if (node.type != 'tag') {
		throw new Error('Top level should be a tag');
	}

	var body = visitTag(node);
	
	var bufferInit = b.variableDeclaration('var', [
		b.variableDeclarator(
			b.identifier('buffer'),
			b.literal("")
		)
	])

	var entry = body[body.length-1].id

	var program = b.program(
			concat(
				bufferInit,
				body,
				singleExport(
					b.functionExpression(
						b.identifier("main"),
						[b.identifier("model")],
						b.blockStatement([
							declareEmptyArray('buffer'),
							b.expressionStatement(
								b.callExpression(
									entry,
									[b.identifier('model'), b.identifier('buffer')]
								)
							),

							b.returnStatement(
								b.callExpression(
									b.memberExpression(
										b.identifier("buffer"),
										b.identifier("join"),
										false
									),
									[b.literal("")]
								)
							)

						])
					)
				)
			)
	)

	console.log(escodegen.generate(program));
}

function visit(node) {
	switch (node.type) {
		case 'tag':
			return visitTag(node)
			break;
		case 'text':
			return visitText(node)
			break;
		default:
			throw new Error('unknown type', node)
	}
}

function visitTag(tag, parentJsNode) {
	log.debug(tag)

	var children = tag.children && tag.children.map(visit) || []
	var topLevel = children.map(last)
	var declarations = flatten(children).filter(function (t) {
			return t.type === 'FunctionDeclaration' })
	
	var append = topLevel.filter(defined).map(output)

	return declarations.concat([
		b.functionDeclaration(
			b.identifier(nameFromTag(tag)),
			[ b.identifier('model'), b.identifier('buffer') ],
			b.blockStatement(
				[startTag(tag)].concat(append).concat([endTag(tag)])
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
			return concatLiteral(node)
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

function concatLiteral(node) {
	return  b.expressionStatement(
						b.callExpression(
							b.memberExpression(
								b.identifier('buffer'),
								b.identifier('push'),
								false
							),
							[node]
						)
					)
}

function startTag(tag) {
	return  concatLiteral(
						b.literal('<' + tag.name + '>')
					)
}

function endTag(tag) {
	return  concatLiteral(
					b.literal('</' + tag.name + '>')
				)
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

var i = 0

var names = []

function nameFromTag(node) {
	return node.name + i++;
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