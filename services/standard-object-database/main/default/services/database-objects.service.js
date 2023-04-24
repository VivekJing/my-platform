/*
 * @Author: baozhoutao@steedos.com
 * @Date: 2023-04-21 16:25:07
 * @LastEditors: baozhoutao@steedos.com
 * @LastEditTime: 2023-04-23 19:05:26
 * @Description: 
 */
var packageServiceName = '~database-objects'

module.exports = {
    name: packageServiceName,
    namespace: "steedos",

    dependencies: ['~packages-standard-objects'],
    
    /**
	 * Actions
	 */
	actions: {

	},

	/**
	 * Events
	 */
	events: {
        
	},

	/**
	 * Methods
	 */
	methods: {
        changeTriggerMetadata: {
            async handler(trigger){
                await this.broker.call(`object_triggers.add`, { apiName: `${trigger.listenTo}.${trigger.name}`, data: trigger }, {
                    meta: {
                    metadataServiceName: packageServiceName,
                    caller: {
                        nodeID: this.broker.nodeID,
                        service: {
                            name: packageServiceName,
                        }
                    }
                }});
                this.broker.broadcast('metadata.object_triggers.add', {apiName: `${trigger.listenTo}.${trigger.name}`, listenTo: trigger.listenTo})
            }
        },
        subTriggers: {
            async handler(){
                return Creator.getCollection("object_triggers").find({is_enable: true}, {
                    fields: {
                        created: 0,
                        created_by: 0,
                        modified: 0,
                        modified_by: 0
                    }
                }).observe({
                    added: (newDocument)=>{
                        return this.changeTriggerMetadata(newDocument);
                    },
                    changed: (newDocument, oldDocument) => {
                        return this.changeTriggerMetadata(newDocument);
                    },
                    removed: (oldDocument) => {
                        return this.changeTriggerMetadata(oldDocument);
                    }
                });
            }
        }
	},

	/**
	 * Service created lifecycle event handler
	 */
	async created() {
        console.log('=======created====>', )
	},

	/**
	 * Service started lifecycle event handler
	 */
	async started() {
        Meteor.startup(async ()=>{
            this.subTriggers = await this.subTriggers();
        })
	},

	/**
	 * Service stopped lifecycle event handler
	 */
	async stopped() {
        // TODO 停止服务时, 需要执行以下操作
        // 1 stop订阅
        // 2 清理元数据
	}
}