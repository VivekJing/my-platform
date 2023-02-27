/*
 * @Author: baozhoutao@steedos.com
 * @Date: 2023-02-26 15:22:12
 * @LastEditors: baozhoutao@steedos.com
 * @LastEditTime: 2023-02-27 17:42:19
 * @Description:
 */
try {
  Steedos.authRequest = function (url, options) {
    var userSession = Creator.USER_CONTEXT;
    var spaceId = userSession.spaceId;
    var authToken = userSession.authToken
      ? userSession.authToken
      : userSession.user.authToken;
    var result = null;
    url = Steedos.absoluteUrl(url);
    try {
      var authorization = "Bearer " + spaceId + "," + authToken;
      var headers = [
        {
          name: "Content-Type",
          value: "application/json",
        },
        {
          name: "Authorization",
          value: authorization,
        },
      ];

      var defOptions = {
        type: "get",
        url: url,
        dataType: "json",
        contentType: "application/json",
        beforeSend: function (XHR) {
          if (headers && headers.length) {
            return headers.forEach(function (header) {
              return XHR.setRequestHeader(header.name, header.value);
            });
          }
        },
        success: function (data) {
          result = data;
        },
        error: function (XMLHttpRequest, textStatus, errorThrown) {
          console.error(XMLHttpRequest.responseJSON);
          if (
            XMLHttpRequest.responseJSON &&
            XMLHttpRequest.responseJSON.error
          ) {
            const errorInfo = XMLHttpRequest.responseJSON.error;
            result = { error: errorInfo };
            let errorMsg;
            if (errorInfo.reason) {
              errorMsg = errorInfo.reason;
            } else if (errorInfo.message) {
              errorMsg = errorInfo.message;
            } else {
              errorMsg = errorInfo;
            }
            toastr.error(t(errorMsg.replace(/:/g, "：")));
          } else {
            toastr.error(XMLHttpRequest.responseJSON);
          }
        },
      };
      $.ajax(Object.assign({}, defOptions, options));
      return result;
    } catch (err) {
      console.error(err);
      toastr.error(err);
    }
  };

  window.UI_SCHEMA_CACHE = {};

  const setUISchemaCache = (key, value) => {
    UI_SCHEMA_CACHE[key] = value;
  };

  const getUISchemaCache = (key) => {
    return _.cloneDeep(UI_SCHEMA_CACHE[key]);
  };

  const hasUISchemaCache = (key) => {
    return _.has(UI_SCHEMA_CACHE, key);
  };

  function formatUISchemaCache(objectName, uiSchema) {
    setUISchemaCache(objectName, uiSchema);
    _.each(uiSchema.fields, (field) => {
      try {
        if (
          field.type === "lookup" &&
          field._reference_to &&
          _.isString(field._reference_to)
        ) {
          field.reference_to = eval(`(${field._reference_to})`)();
        }
      } catch (exception) {
        field.reference_to = undefined;
        console.error(exception);
      }
    });
    _.each(uiSchema.list_views, (v, k) => {
      v.name = k;
      if (!_.has(v, "columns")) {
        v.columns = uiSchema.list_views.all.columns;
      }
    });
  }

  window.getUISchemaSync = (objectName, force) => {
    if (!objectName) {
      return;
    }
    if (hasUISchemaCache(objectName) && !force) {
      return getUISchemaCache(objectName);
    }
    let uiSchema = null;
    try {
      const url = `/service/api/@${objectName.replace(/\./g, "_")}/uiSchema`;
      uiSchema = Steedos.authRequest(url, {
        type: "GET",
        async: false,
      });

      if (!uiSchema) {
        return;
      }
      formatUISchemaCache(objectName, uiSchema);
    } catch (error) {
      console.error(`getUISchema`, objectName, error);
      setUISchemaCache(objectName, null);
    }
    return getUISchemaCache(objectName);
  };

  window.getFirstListView = (objectName)=>{
    const uiSchema = window.getUISchemaSync(objectName);
    return _.first(_.sortBy(_.values(uiSchema.list_views) , 'sort_no'));
  }


  Creator.steedosInit.set(true);
} catch (error) {
  console.error(error);
}
