const defaultValueTriggers = require('./defaultValueTriggers');

module.exports = {
    listenTo: 'base',
    beforeInsert: defaultValueTriggers.beforeInsert
}