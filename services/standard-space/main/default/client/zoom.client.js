/*
 * @Author: baozhoutao@steedos.com
 * @Date: 2023-08-22 10:36:38
 * @LastEditors: 殷亮辉 yinlianghui@hotoa.com
 * @LastEditTime: 2023-08-25 17:18:16
 * @Description: 
 */
Tracker.autorun(function(e) {
    let zoom = "normal";
    let space = db.space_users.findOne({ user: Steedos.userId(), space: Steedos.spaceId() });
    if(space && space.zoom){
        zoom = space.zoom;
    }
    if(Steedos.isMobile()){
        $("body").removeClass("zoom-normal").removeClass("zoom-large").removeClass("zoom-extra-large");
        $("body").addClass("zoom-" + zoom);
        let zoomRate = 1;
        if(zoom == "large"){
            zoomRate = 1.25;
        }else if(zoom == 'extra-large'){
            zoomRate = 1.35;
        }
        if(zoomRate > 1){
            // var screenWidth = (window.innerWidth > 0) ? window.innerWidth : screen.width;
            var screenWidth = screen.width;
            let zoomWidth = screenWidth / zoomRate;
            document.querySelector("meta[name=viewport]").setAttribute("content", "width=" + zoomWidth + ", user-scalable=0");
        }
        else{
            document.querySelector("meta[name=viewport]").setAttribute("content", "user-scalable=no, initial-scale=1, maximum-scale=1, minimum-scale=1, width=device-width");
        }
    }else if(Steedos.isNode()){
        let zoomRate = 1;
        if(zoom == "large"){
            zoomRate = 1.25;
        }else if(zoom == 'extra-large'){
            zoomRate = 2.0;
        }
        chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
            var tabId = tabs[0].id;
            chrome.tabs.setZoom(tabId, zoomRate)
        });
    }
})