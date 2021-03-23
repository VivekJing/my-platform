import { SteedosObjectType } from '../types/object';
import { getDataSource } from '../types/datasource';
import { getObjectConfig } from '../types/object_dynamic_load';
import _ = require('underscore');
import { generateActionRestProp, generateActionGraphqlProp, generateSettingsGraphql, RELATED_PREFIX, _getRelatedType, correctName } from './helpers';
import { getObjectServiceName } from '.';
import { getSteedosSchema } from '../types';
// import { parse } from '@steedos/formula';
// mongodb pipeline: https://docs.mongodb.com/manual/core/aggregation-pipeline/
type externalPipelineItem = {
    [mongodPipeline: string]: any
}
function getObjectServiceMethodsSchema() {
    const methods = {
        aggregate: {
            async handler(query, externalPipeline: Array<externalPipelineItem>, userSession) {
                return await this.object.aggregate(query, externalPipeline, userSession)
            }
        },
        find: {
            async handler(query, userSession) {
                if (this.object.name == 'users') {
                    return await this.object.find(query)
                }
                return await this.object.find(query, userSession)
            }
        },
        findOne: {
            async handler(id: string, query, userSession) {
                if (this.object.name == 'users') {
                    return await this.object.findOne(id, query)
                }
                return await this.object.findOne(id, query, userSession)
            }
        },
        insert: {
            async handler(doc, userSession) {
                return await this.object.insert(doc, userSession)
            }
        },
        update: {
            async handler(id, doc, userSession) {
                return await this.object.update(id, doc, userSession)
            }
        },
        updateOne: {
            async handler(id, doc, userSession) {
                return await this.object.updateOne(id, doc, userSession)
            }
        },
        updateMany: {
            async handler(queryFilters, doc, userSession) {
                return await this.object.updateMany(queryFilters, doc, userSession)
            }
        },
        delete: {
            async handler(id, userSession) {
                return await this.object.delete(id, userSession)
            }
        },
        directAggregate: {
            async handler(query, externalPipeline: Array<externalPipelineItem>, userSession) {
                return await this.object.directAggregate(query, externalPipeline, userSession)
            }
        },
        directAggregatePrefixalPipeline: {
            async handler(query, externalPipeline: Array<externalPipelineItem>, userSession) {
                return await this.object.directAggregatePrefixalPipeline(query, externalPipeline, userSession)
            }
        },
        directFind: {
            async handler(query, userSession) {
                return await this.object.directFind(query, userSession)
            }
        },
        directInsert: {
            async handler(doc, userSession) {
                return await this.object.directInsert(doc, userSession)
            }
        },
        directUpdate: {
            async handler(id, doc, userSession) {
                return await this.object.directUpdate(id, doc, userSession)
            }
        },
        directDelete: {
            async handler(id, userSession) {
                return await this.object.directDelete(id, userSession)
            }
        },
        count: {
            async handler(query, userSession) {
                return await this.object.count(query, userSession)
            }
        },
        getField: {
            handler(fieldName) {
                return this.object.getField(fieldName).toConfig()
            }
        },
        getFields: {
            handler() {
                return this.object.toConfig().fields;
            }
        },
        getNameFieldKey: {
            handler() {
                return this.object.getNameFieldKey();
            }
        },
        toConfig: {
            handler() {
                return this.object.toConfig()
            }
        },
        getUserObjectPermission: {
            handler(userSession) {
                return this.object.getUserObjectPermission(userSession)
            }
        },
        isEnableAudit: {
            handler() {
                return this.object.isEnableAudit()
            }
        },
        _makeNewID: {
            async handler() {
                return await this.object._makeNewID();
            }
        },
        getRecordAbsoluteUrl: {
            async handler() {
                return this.object.getRecordAbsoluteUrl();
            }
        },
        getGridAbsoluteUrl: {
            async handler() {
                return this.object.getGridAbsoluteUrl();
            }
        },
        getRecordPermissions: {
            async handler(record, userSession) {
                return this.object.getRecordPermissions(record, userSession);
            }
        }
    };

    return methods;
}

function getObjectServiceActionsSchema() {
    const actions: any = {
        aggregate: {
            params: {
                query: { type: "object" },
                externalPipeline: { type: "array", items: "object" }
            },
            async handler(ctx) {
                const userSession = ctx.meta.user;
                const { query, externalPipeline } = ctx.params;
                return await this.aggregate(query, externalPipeline, userSession)
            }
        },
        find: {
            params: {
                fields: { type: 'array', items: "string", optional: true },
                filters: { type: 'array', optional: true },
                top: { type: 'number', optional: true },
                skip: { type: 'number', optional: true },
                sort: { type: 'string', optional: true }
            },
            async handler(ctx) {
                const userSession = ctx.meta.user;
                return this.find(ctx.params, userSession)
            }
        },
        findOne: {
            params: {
                id: { type: "any" },
                query: { type: "object", optional: true }
            },
            async handler(ctx) {
                const userSession = ctx.meta.user;
                const { id, query } = ctx.params;
                return this.findOne(id, query, userSession)
            }
        },
        insert: {
            params: {
                doc: { type: "object" }
            },
            async handler(ctx) {
                const userSession = ctx.meta.user;
                const { doc } = ctx.params;
                return this.insert(doc, userSession)
            }
        },
        update: {
            params: {
                id: { type: "any" },
                doc: { type: "object" }
            },
            async handler(ctx) {
                const userSession = ctx.meta.user;
                const { id, doc } = ctx.params;
                return this.update(id, doc, userSession)
            }
        },
        updateOne: {
            params: {
                id: { type: "any" },
                doc: { type: "object" }
            },
            async handler(ctx) {
                const userSession = ctx.meta.user;
                const { id, doc } = ctx.params;
                return this.updateOne(id, doc, userSession)
            }
        },
        updateMany: {
            params: {
                queryFilters: { type: "array", items: "any" },
                doc: { type: "object" }
            },
            async handler(ctx) {
                const userSession = ctx.meta.user;
                const { queryFilters, doc } = ctx.params;
                return this.updateMany(queryFilters, doc, userSession)
            }
        },
        delete: {
            params: {
                id: { type: "any" }
            },
            async handler(ctx) {
                const userSession = ctx.meta.user;
                const { id } = ctx.params;
                return this.delete(id, userSession)
            }
        },
        directAggregate: {
            params: {
                query: { type: "object" },
                externalPipeline: { type: "array", items: "object" }
            },
            async handler(ctx) {
                const userSession = ctx.meta.user;
                const { query, externalPipeline } = ctx.params;
                return this.directAggregate(query, externalPipeline, userSession)
            }
        },
        directAggregatePrefixalPipeline: {
            params: {
                query: { type: "object" },
                prefixalPipeline: { type: "array", items: "object" }
            },
            async handler(ctx) {
                const userSession = ctx.meta.user;
                const { query, prefixalPipeline } = ctx.params;
                return this.directAggregatePrefixalPipeline(query, prefixalPipeline, userSession)
            }
        },
        directFind: {
            params: {
                fields: { type: 'array', items: "string", optional: true },
                filters: { type: 'array', optional: true },
                top: { type: 'number', optional: true },
                skip: { type: 'number', optional: true },
                sort: { type: 'string', optional: true }
            },
            async handler(ctx) {
                const userSession = ctx.meta.user;
                return this.directFind(ctx.params, userSession)
            }
        },
        directInsert: {
            params: {
                doc: { type: "object" }
            },
            async handler(ctx) {
                const userSession = ctx.meta.user;
                const { doc } = ctx.params;
                return this.directInsert(doc, userSession)
            }
        },
        directUpdate: {
            params: {
                id: { type: "any" },
                doc: { type: "object" }
            },
            async handler(ctx) {
                const userSession = ctx.meta.user;
                const { id, doc } = ctx.params;
                return this.directUpdate(id, doc, userSession)
            }
        },
        directDelete: {
            params: {
                id: { type: "any" },
            },
            async handler(ctx) {
                const userSession = ctx.meta.user;
                const { id } = ctx.params;
                return this.directDelete(id, userSession)
            }
        },
        count: {
            rest: {
                method: "GET",
                path: "/count"
            },
            params: {
                query: { type: "object" }
            },
            async handler(ctx) {
                const userSession = ctx.meta.user;
                const { query } = ctx.params;
                return this.count(query, userSession)
            }
        },
        getField: {
            rest: {
                method: "GET",
                path: "/field"
            },
            params: {
                fieldApiName: { type: "string" },
            },
            async handler(ctx) {
                const { fieldApiName } = ctx.params;
                return this.getField(fieldApiName)
            }
        },
        getFields: {
            rest: {
                method: "GET",
                path: "/fields"
            },
            async handler(ctx) {
                return this.getFields()
            }
        },
        getNameFieldKey: {
            async handler(ctx) {
                return this.getNameFieldKey()
            }
        },
        toConfig: {
            async handler(ctx) {
                return this.toConfig()
            }
        },
        getUserObjectPermission: {
            rest: {
                method: "GET",
                path: "/getUserObjectPermission"
            },
            async handler(ctx) {
                const userSession = ctx.meta.user;
                return this.getUserObjectPermission(userSession)
            }
        },
        isEnableAudit: {
            async handler() {
                return this.isEnableAudit();
            }
        },
        _makeNewID: {
            async handler() {
                return await this._makeNewID();
            }
        },
        getRecordAbsoluteUrl: {
            async handler() {
                return this.getRecordAbsoluteUrl();
            }
        },
        getGridAbsoluteUrl: {
            async handler() {
                return this.getGridAbsoluteUrl();
            }
        },
        getRecordPermissions: {
            async handler(ctx) {
                const userSession = ctx.meta.user;
                const { record } = ctx.params;
                return this.getRecordPermissions(record, userSession);
            }
        }
    };
    return actions;
}

export function getObjectServiceSchema(serviceName, objectConfig) {
    return {
        name: serviceName,
        actions: getObjectServiceActionsSchema(),
        methods: getObjectServiceMethodsSchema(),
        created() {
            this.object = new SteedosObjectType(objectConfig.name, getDataSource(objectConfig.datasource), objectConfig);
        }
    }
}

module.exports = {
    name: '#_objectBaseService', //TODO
    settings: {
        // objectApiName:  //TODO
        // objectConfig
    },
    actions: getObjectServiceActionsSchema(),
    methods: getObjectServiceMethodsSchema(),
    created(broker) {
        if (!this.settings.objectApiName && !this.settings.objectConfig) {
            throw new Error('Please set the settings.objectApiName.')
        }
        const objectConfig: any = this.settings.objectConfig || getObjectConfig(this.settings.objectApiName);
        if (!objectConfig) {
            throw new Error('Not found object config by objectApiName.')
        }
        const datasource = getDataSource(objectConfig.datasource);
        if (datasource) {
            this.object = datasource.getLocalObject(objectConfig.name);
        }
    },
    merged(schema) {
        let settings = schema.settings;
        let objectConfig = settings.objectConfig;
        if (objectConfig.enable_api) {
            _.each(schema.actions, (action, actionName) => {
                let rest = generateActionRestProp(actionName);
                if (rest.method) {
                    action.rest = rest;
                }
            })
        }
        if (objectConfig.enable_graphql || true) { // TODO object.yml添加enable_graphql属性
            _.each(schema.actions, (action, actionName) => {
                let gpObj = generateActionGraphqlProp(actionName, objectConfig);
                if (!_.isEmpty(gpObj)) {
                    action.graphql = gpObj;
                }
            })
            settings.graphql = generateSettingsGraphql(objectConfig);
        }
        if (!schema.events) {
            schema.events = {};
        }
        schema.events[`${getObjectServiceName(objectConfig.name)}.detailsChanged`] = {
            handler: async function (ctx) {
                const { objectApiName, detailObjectApiName, detailFieldName, detailFieldReferenceToFieldName } = ctx.params;

                let resolvers = this.settings.graphql.resolvers;
                let type: string = this.settings.graphql.type;
                let relatedFieldName = correctName(`${RELATED_PREFIX}_${detailObjectApiName}_${detailFieldName}`);
                let relatedType = _getRelatedType(relatedFieldName, detailObjectApiName);
                if (type.indexOf(relatedType) > -1) { // 防止重复定义field
                    return;
                }
                this.settings.graphql.type = type.substring(0, type.length - 1) + relatedType + '}';
                resolvers[objectApiName][relatedFieldName] = async function (parent, args, context, info) {
                    let userSession = context.ctx.meta.user;
                    let steedosSchema = getSteedosSchema();
                    let object = steedosSchema.getObject(detailObjectApiName);
                    let filters = [];
                    let _idValue = parent._id;
                    if (detailFieldReferenceToFieldName) {
                        _idValue = parent[detailFieldReferenceToFieldName];
                    }
                    filters = [[detailFieldName, "=", _idValue]];
                    if (args && args.filters) {
                        filters.push(args.filters);
                    }
                    args.filters = filters;
                    return await object.find(args, userSession);
                };

            }
        };
        schema.events[`${getObjectServiceName(objectConfig.name)}.metadata.objects.inserted`] = {
            handler: async function (ctx) {
                let objectConfig = ctx.params.data;
                let gobj = generateSettingsGraphql(objectConfig);
                this.settings.graphql = gobj;
                ctx.emit('$services.changed');
            }
        }
    },
}