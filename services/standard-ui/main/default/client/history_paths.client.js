/*
 * @Author: 殷亮辉 yinlianghui@hotoa.com
 * @Date: 2023-05-16 17:00:38
 * @LastEditors: 殷亮辉 yinlianghui@hotoa.com
 * @LastEditTime: 2023-05-28 10:13:45
 */
var buttonTriggerHistoryPathsChange;
; (function () {
    try {
        var rootId = "steedosHistoryPathsRoot";
        var modalRoot = document.getElementById(rootId);
        if (!modalRoot) {
            modalRoot = document.createElement('div');
            modalRoot.setAttribute('id', rootId);
            $("body")[0].appendChild(modalRoot);
        }
        const page = {
            name: "pageSteedosHistoryPaths",
            render_engine: "amis",
            schema: {
                name: "serviceSteedosHistoryPaths",
                id: "serviceSteedosHistoryPaths",
                type: "service",
                className: "service-steedos-history-paths",
                body: [{
                    "type": "button",
                    "label": "触发@history_paths.changed",
                    "name": "buttonTriggerHistoryPathsChange",
                    "className": "button-trigger-history-paths-change hidden",
                    "onEvent": {
                        "click": {
                            "actions": [
                                {
                                    "actionType": "broadcast",
                                    "args": {
                                        "eventName": "@history_paths.changed"
                                    }
                                }
                            ]
                        }
                    }
                }]
            }
        };
        Meteor.startup(function () {
            const root = $("#" + rootId)[0];
            Tracker.autorun(function (c) {
                if (Creator.steedosInit.get() && Creator.validated.get()) {
                    Steedos.Page.render(root, page, {});
                    const findVars = (obj, vars) => {
                        try {
                            return vars.length === vars.filter(function (item) {
                                return item.split(".").reduce(function (sum, n) {
                                    return sum[n];
                                }, obj) !== undefined;
                            }).length;
                        }
                        catch (ex) {
                            return false;
                        }
                    }
                    const waittingVars = ["SteedosUI.refs.serviceSteedosHistoryPaths.getComponentByName"];
                    Promise.all([
                        waitForThing(window, waittingVars, findVars)
                    ]).then(() => {
                        var scope = SteedosUI.refs["serviceSteedosHistoryPaths"];
                        buttonTriggerHistoryPathsChange = scope.getComponentByName("serviceSteedosHistoryPaths.buttonTriggerHistoryPathsChange");
                        Object.assign(Steedos, {
                            goBack
                        });
                    });
                }
            });
        });

    } catch (error) {
        console.error(error)
    };
})();

let historyPathsStoreKey = "history_paths";

// 使用debounce防抖动函数，连续多次自动触发enter事件时，只需要捕获最后一次
FlowRouter.triggers.enter(debounce(function (context, redirect, stop) {
    if(!!window.opener){
        // 记录详细页面点击右上角查看审批单等打开新窗口情况下，新窗口的history path继承了opener页面的history path，所以需要区别出来，否则会报错
        historyPathsStoreKey = "history_paths_opener_level" + getOpenerLevel(window,0);
    }
    const path = context.path;
    const params = context.params || {};
    // const pathDef = context.route.pathDef;
    const recordId = params.record_id;
    if (recordId) {
        // 触发广播事件，把当前path和params累加存入amis变量historyPaths中
        var paths = getHistoryPaths() || [];
        let lastPath = paths && paths[paths.length - 1];
        //判断当前路由与记录的路由是否相同，为解决从设计器微页面返回重复记录的问题#4978
        if(path.split('?')[0] != lastPath?.path?.split('?')[0]){
            pushHistoryPath(path, params);
        } 
    }
    else {
        // 触发广播事件重围amis变量historyPaths值为空数组，并把当前path和params存入amis变量historyPaths中
        resetHistoryPath(path, params);
    }
    triggerBroadcastHistoryPathsChanged(buttonTriggerHistoryPathsChange);
}, 200));

function goBack(){
    let prevPath = popHistoryPath();
    if(prevPath && prevPath.path){
        FlowRouter.go(prevPath.path);
    }
}

/**
 * 移除最后一个path，并且返回要返回的上一个path
 * 如果是从推送通知中点开进入记录详细页面，则返回当前记录所属对象的列表页面
 */
function popHistoryPath() {
    var paths = getHistoryPaths() || [];
    let lastPath = paths && paths[paths.length - 1];
    paths.pop();
    setHistoryPaths(paths);
    let prevPath = paths && paths[paths.length - 1];
    if(!prevPath && lastPath){
        // 如果是从推送通知中点开进入记录详细页面，在paths.pop()前的paths肯定只有当前记录详细页面的path
        // 此时lastPath肯定是记录详细页面，值如以下格式：
        /**{
            "path": "/app/projects/project_program/view/6465c790f85da77bbccefbe6",
            "params": {
                "app_id": "projects",
                "object_name": "project_program",
                "record_id": "6465c790f85da77bbccefbe6"
            }
        }**/
        prevPath = {
            path: `/app/${lastPath.params.app_id || "-"}/${lastPath.params.object_name}`,
            params: {
                app_id: lastPath.params.app_id,
                object_name: lastPath.params.object_name
            }
        }
    }
    return prevPath;
}

function pushHistoryPath(path, params) {
    let paths = getHistoryPaths() || [];
    let lastPath = paths && paths[paths.length - 1];
    if(lastPath && lastPath.path === path){
        // 点返回按钮执行goBack函数触发FlowRouter.triggers.enter从而进入该函数，此时lastPath肯定跟传入的path值一样，正好排除掉不重复加入paths
        return;
    }
    paths.push({ path, params });
    setHistoryPaths(paths);
}

function resetHistoryPath(path, params) {
    setHistoryPaths([{ path, params }]);
}

function getHistoryPaths() {
    if (!window.historyPaths) {
        var paths = sessionStorage.getItem(historyPathsStoreKey);
        if (paths) {
            window.historyPaths = JSON.parse(paths);
        }else{
            window.historyPaths = [];
        }
    }
    return window.historyPaths;
}

function setHistoryPaths(paths) {
    window.historyPaths = paths;
    sessionStorage.setItem(historyPathsStoreKey, JSON.stringify(paths));
}

function triggerBroadcastHistoryPathsChanged(button) {
    if (button) {
        button.props.dispatchEvent('click', {});
    }
}

function debounce(fn, delay) {
    let time = null;
    return function (...args) {
        if (time) {
            clearTimeout(time);
        }
        time = setTimeout(() => {
            fn.apply(this, args);
        }, delay)
    }
}

function getOpenerLevel(opener,level){
    if (!!opener['opener']) {
        return getOpenerLevel(opener['opener'], level + 1);
    }else{
       return level; 
    }
}