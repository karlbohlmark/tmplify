var tmplify = require('./')
var template = require('./tmpl')

var model = {}
var product = {
    name: "Balans",
    tags: ["print", "fågel"],
    imageSmall: "http://placekitten.com/200/100?image=1"
}
var order = {}
var item = {}
item.product = product
item.quantity = 3;
item.price = function () {
    return 100
}
item.total = function () {
    return this.price() * this.quantity
}
order.items = [item];

var item2 = JSON.parse(JSON.stringify(item))
item2.product.name = 'Kung koltrast'
//order.items.push(item2)

model.order = order

tmplify(template, function (err, res) {
    var m = {};
    var fn = eval("(function (module) {" +  res + ";return module.exports;}) \n//# sourceURL=template.js")(m);
    

    document.body.innerHTML = m.exports(model);
})

