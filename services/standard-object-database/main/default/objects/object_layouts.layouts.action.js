/*
 * @Author: 廖大雪 2291335922@qq.com
 * @Date: 2023-01-09 15:34:24
 * @LastEditors: 廖大雪 2291335922@qq.com
 * @LastEditTime: 2023-03-14 09:15:15
 * @FilePath: /steedos-platform/services/standard-object-database/main/default/objects/object_layouts.layouts.action.js
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
module.exports = {
  listenTo: 'object_layouts',

  customize: function (object_name, record_id, fields) {
    let doc = Creator.odata.get(object_name, record_id);
    var newRecord = _.pick(doc, Creator.getObjectFieldsName(object_name));
    delete newRecord.is_system;
    delete newRecord._id;
    newRecord.from_code_id = record_id;
    Creator.odata.insert(object_name, newRecord, function(result, error){
        if(result){
            FlowRouter.go(`/app/-/${object_name}/view/${result._id}`)
        }
    });
  },
  customizeVisible: function(object_name, record_id, record_permissions, record){
      return Creator.baseObject.actions.standard_new.visible() && record.is_system;
  },
  // standard_new: function (object_name, record_id, fields){
	// 	var object = Creator.getObject(object_name);
  //   var gridName = this.action.gridName;
  //   // var isRelated = this.action.isRelated;
  //   var relatedFieldName = this.action.relatedFieldName;
  //   var masterRecordId = this.action.masterRecordId;
  //   var initialValues = this.action.initialValues
  //   if(!initialValues){
  //     initialValues = {};
  //     initialValues[relatedFieldName] = masterRecordId
  //   }
  //   const appId = Session.get("app_id");
  //   const page = Steedos.Page.getPage('form', appId, object_name);
  //   const title = t('New') + ' ' + object.label;
  //   if (page && page.schema) {
  //     const options = {
  //       gridName: gridName
  //     };
  //     const fullScreenProps = {
  //       "width": "96%", 
  //       className: "!max-w-[96%]"
  //     };
  //     Steedos.Page.render(SteedosUI.Modal, page, Object.assign({}, options, {
  //       appId: appId,
  //       objectName: object_name,
  //       title: title,
  //       data: initialValues,
  //     }), {
  //       props: fullScreenProps
  //     });
  //   }
  // },
  /*
  standard_edit: function (object_name, record_id, fields){
		var object = Creator.getObject(object_name);
    var gridName = this.action.gridName;
    const appId = Session.get("app_id");
    const page = Steedos.Page.getPage('form', appId, object_name, record_id);
    const title = t('Edit') + ' ' + object.label;
    if (page && page.schema) {
      const options = {
        gridName: gridName
      };
      const fullScreenProps = {
        "width": "96%", 
        className: "!max-w-[96%]"
      };
      Steedos.Page.render(SteedosUI.Modal, page, Object.assign({}, options, {
        appId: appId,
        objectName: object_name,
        title: title,
        recordId: record_id
      }), {
        props: fullScreenProps
      });
    }
  }
  */
}