/*
 * @Author: baozhoutao@steedos.com
 * @Date: 2023-08-27 10:41:47
 * @LastEditors: baozhoutao@steedos.com
 * @LastEditTime: 2023-08-27 17:25:13
 * @Description: 
 */
;(function(){
    const getCurd = (template)=>{
        window._selectUserModalOnConfirm = ()=>{
            Steedos.Page.Blaze.selectUserModalBody.onConfirm(null, template);
        }
        if(template.data.multiple == true){
            return {
                "onEvent": {
                    "selectedChange": {
                        "actions": [
                            {
                                "actionType": "custom",
                                "script": "Session.set('_selectUsers', event.data.selectedItems)"
                            }
                        ]
                    }
                }
            }
        }else{
            return {
                "onEvent": {
                    "selectedChange": {
                        "actions": [
                            {
                                "actionType": "custom",
                                "script": "Session.set('_selectUsers', event.data.selectedItems)"
                            },
                            {
                                "actionType": "custom",
                                "script": `
                                    window._selectUserModalOnConfirm();
                                `
                            }
                        ]
                    }
                }
            }
        }
        return null;
    }

    const getSelectUserModalBodySchema = (template)=>{
        return {
          "type": "page",
          "body": [
            {
              "type": "service",
              "id": "u:f6a209c8cf61",
              "data": {
                "isVisible": true
              },
              "messages": {
              },
              "body": [
                {
                  "type": "steedos-object-table",
                  "className": "sm:border sm:shadow sm:rounded sm:border-gray-300 bg-white",
                  "id": "u:f259c69e3c93",
                  "objectApiName": "space_users",
                  "label": "对象表格",
                  "fields": [
                    "name"
                  ],
                  "sortField": "sort_no",
                  "sortOrder": "desc",
                  "headerToolbarItems": [
                    {
                      "type": "button",
                      "label": "组织",
                      "icon": "fa fa-sitemap",
                      "className": "bg-white p-2 rounded border-gray-300 text-gray-500",
                      "align": "left",
                      "onEvent": {
                        "click": {
                          "actions": [
                            {
                              "actionType": "custom",
                              "script": "console.log(event.target);document.querySelector('.select-users-list').classList.toggle('select-users-sidebar-open');if(window.innerWidth < 768){document.querySelector('.isInset').classList.toggle('inset-0')}"
                            }
                          ]
                        }
                      },
                      "id": "u:115e270cae4d",
                      "visibleOn": "${window:innerWidth < 768 && showOrg}"
                    }
                  ],
                  "extraColumns": [
                    "user"
                  ],
                  "crud": Object.assign({},getCurd(template),{
                    "autoFillHeight": false
                  })
                },
                {
                  "type": "action",
                  "body": [
                    {
                      "type": "action",
                      "className": {
                        "mobileCss": "${window:innerWidth < 768}",
                        "pcCss": "${window:innerWidth > 768}",
                        "select-users-sidebar-wrapper px-0 fixed z-20 ease-in-out duration-300 flex flex-col border-r overflow-y-auto bg-white border-slate-200 block -translate-x-0 py-0": "true"
                      },
                      "body": [
                        {
                          "type": "input-tree",
                          "id": "u:7fd77b7915b0",
                          "className": "select-users-box-tree bg-white h-full w-full",
                          "source": {
                            "method": "post",
                            "url": "${context.rootUrl}/graphql",
                            "headers": {
                              "Authorization": "Bearer ${context.tenantId},${context.authToken}"
                            },
                            "adaptor": "        if (payload.data.cache == true) {\n                return payload;\n        }\n        const records = payload.data.options;\n        const treeRecords = [];\n        const getChildren = (records, childrenIds) => {\n                if (!childrenIds) {\n                        return;\n                }\n                const children = _.filter(records, (record) => {\n                        return _.includes(childrenIds, record.value)\n                });\n                _.each(children, (item) => {\n                        if (item.children) {\n                                item.children = getChildren(records, item.children)\n                        }\n                })\n                return children;\n        }\n\n        const getRoot = (records) => {\n                for (var i = 0; i < records.length; i++){\n                        records[i].noParent = 0;\n                        if (!!records[i].parent) {\n                                biaozhi = 1\n                                for (var j = 0; j < records.length; j++){\n                                        if (records[i].parent == records[j].value)\n                                                biaozhi = 0;\n                                }\n                                if (biaozhi == 1) records[i].noParent = 1;\n                        } else records[i].noParent = 1;\n                }\n        }\n        getRoot(records);\n\n        _.each(records, (record) => {\n                if (record.noParent ==1) {\n                        treeRecords.push(Object.assign({}, record, { children: getChildren(records, record.children) }));\n                }\n        });\n\n        payload.data.options = treeRecords;\n        payload.data.cache = true;\n        return payload;\n    ",
                            "requestAdaptor": "\n    ",
                            "data": {
                              "query": "{options:organizations(filters:[\"hidden\", \"!=\", true],sort:\"sort_no desc\"){value:_id label:name,parent,children}}"
                            },
                            "messages": {
                            },
                            "cache": 300000
                          },
                          "onEvent": {
                            "change": {
                              "actions": [
                                {
                                  "actionType": "setValue",
                                  "componentId": "u:f6a209c8cf61",
                                  "args": {
                                    "value": {
                                      "additionalFilters": [
                                        "organizations_parents",
                                        "in",
                                        "${event.data.value.value | asArray}"
                                      ]
                                    }
                                  }
                                },
                                {
                                  "actionType": "custom",
                                  "script": " if(window.innerWidth < 768){ document.querySelector('.select-users-list').classList.remove('select-users-sidebar-open');document.querySelector('.isInset').classList.remove('inset-0') }"
                                }
                              ]
                            }
                          },
                          "label": "",
                          "name": "organizations",
                          "multiple":false,
                          "joinValues": false,
                          "clearValueOnHidden": false,
                          "fieldName": "organizations",
                          "hideRoot": true,
                          "initiallyOpen": false,
                          "extractValue": true,
                          "onlyChildren": true,
                          "treeContainerClassName": "h-full no-border",
                          "showIcon": false,
                          "enableNodePath": false,
                          "autoCheckChildren": true,
                          "searchable": true,
                          "searchConfig": {
                            "sticky": true
                          },
                          "unfoldedLevel": 2,
                          "inputClassName": "",
                          "labelClassName": "",
                          "staticClassName": "",
                          "originPosition": "left-top"
                        }
                      ],
                      "id": "u:04f0e5aafaf0"
                    }
                  ],
                  "onEvent": {
                    "click": {
                      "actions": [
                        {
                          "actionType": "custom",
                          "script": " if(window.innerWidth < 768){ document.querySelector('.select-users-list').classList.remove('select-users-sidebar-open');document.querySelector('.isInset').classList.remove('inset-0') }"
                        }
                      ]
                    }
                  },
                  "className": {
                    "absolute isInset": "true",
                    "inset-0": "${window:innerWidth < 768}"
                  },
                  "id": "u:10896530250e",
                  "visibleOn": "${showOrg}"
                }
              ],
              "className": "h-full",
              "onEvent": {
                "init": {
                  "actions": [
                    {
                      "actionType": "custom",
                      "script": "if (event.data.userOptions) {\r\n  doAction({\r\n    actionType: 'setValue',\r\n    args: {\r\n      value: {\r\n        \"additionalFilters\": [\r\n          [\r\n            \"_id\",\r\n            \"in\",\r\n            event.data.userOptions.split(\",\")\r\n          ]\r\n        ]\r\n      }\r\n    }\r\n  });\r\n} else {\r\n  doAction({\r\n    actionType: 'setValue',\r\n    args: {\r\n      value: {\r\n        \"additionalFilters\": [\r\n        [\r\n          \"organizations_parents\",\r\n          \"in\",\r\n          []\r\n        ]\r\n        ]\r\n      }\r\n    }\r\n  });\r\n}"
                    }
                  ]
                }
              }
            }
          ],
          "regions": [
            "body"
          ],
          "data": {
            "recordId": "",
            "initialValues": {
            },
            "appId": "builder",
            "title": "",
            "context": {
            },
            "objectName": "space_users",
            "showOrg": "${userOptions?false:showOrg}",
            "isLookup": true,
            "userOptions": "${userOptions}",
            "selectedUsers":"${selectedUsers}"
          },
          "id": "u:b7167e2fcaf0",
          "name": "page_space_users_list",
          "asideResizor": false,
          "pullRefresh": {
            "disabled": true
          },
          "bodyClassName": {
            "select-users-pc select-users-minwidth": "${window:innerWidth > 768}",
            "select-users-mobile": "${window:innerWidth < 768}",
            "p-0 select-users-sidebar select-users-list": "true",
            "select-users-sidebar-open": "${showOrg}"
          },
          "css": {
            ".select-users-list": {
              "margin-left": "-15px",
              "margin-right": "-15px"
            },
            ".select-users-pc .antd-Table-content": {
              "height": "1088px",
              "overflow": "auto"
            },
            ".select-users-list.select-users-sidebar.select-users-sidebar-open.select-users-pc": {
              "margin-left": "360px",
              "margin-right": "-15px"
            },
            ".select-users-sidebar-wrapper": {
              "transition": "0.5s ease transform",
              "will-change": "transform",
              "transform": "translate(-100%,0)",
              "-webkit-transform": "translate(-100%,0)",
              "-moz-transform": "translate(-100%,0)",
              "-ms-transform": "translate(-100%,0)",
              "-o-transform": "translate(-100%,0)"
            },
            ".select-users-list.select-users-sidebar-open .select-users-sidebar-wrapper": {
              "transform": "translate(0,0)",
              "-webkit-transform": "translate(0,0)",
              "-moz-transform": "translate(0,0)",
              "-ms-transform": "translate(0,0)",
              "-o-transform": "translate(0,0)"
            },
            ".pcCss": {
              "top": "55px",
              "left": "0",
              "max-height": "calc(100% - 125px)",
              "width": "375px"
            },
            ".mobileCss": {
              "top": "51px",
              "left": "0px",
              "padding-bottom": "65px",
              "height": "calc(100% - 105px)",
              "width": "240px"
            },
            ".select-users-minwidth": {
              "min-width": "388px"
            },
            "body.zoom-extra-large .select-users-list.select-users-mobile .antd-Tree": {
              "max-height": "calc(100vh - 347px) !important",
              "overflow": "auto !important"
            },
            "body.zoom-large .select-users-list.select-users-mobile .antd-Tree": {
              "max-height": "calc(100vh - 271px) !important",
              "overflow": "auto !important"
            },
            ".select-users-list.select-users-mobile .antd-Tree": {
              "max-height": "calc(100vh - 174px) !important",
              "overflow": "auto !important"
            }
          }
        };
    }
    Meteor.startup(function () {
        Steedos.Page.Blaze = {
            selectUserModalBody: {
                render : (template)=>{
                    console.log(`template`, template)
                    const bodyId = template.bodyId;
                    Steedos.Page.render($("#" + bodyId)[0], {
                                    name: bodyId,
                                    render_engine: "amis",
                                    schema: {
                                        type: "service",
                                        body: getSelectUserModalBodySchema(template),
                                        id: bodyId,
                                        data: template.data
                                    }
                                }, {});
                },
                onConfirm: (event, template)=>{
                    const target = template.data.target

                    const values = Session.get("_selectUsers");

                    target.dataset.values = values.getProperty("user").toString();

                    $(target).val(values.getProperty("name").toString()).trigger('change');

                    Modal.hide(template);

                    Modal.allowMultiple = false;
                },
                onRemove: (event, template)=>{
                    const target = template.data.target
                    // target = $("#" + template.data.targetId)
                    target.dataset.values = "";
                    $(target).val("").trigger('change');
                    Modal.hide(template);
                    Modal.allowMultiple = false;
                }
            }
        }
    });
})()