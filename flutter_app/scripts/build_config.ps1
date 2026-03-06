# AirTranslate 构建配置 - Web / Android / iOS 共用
# 切换备案前/后：修改 $UseIpMode，所有打包脚本会同步使用
$UseIpMode = $false   # 备案前改为 $true

if ($UseIpMode) {
  # translate 站点监听 8082，需带端口
  $API_URL = "http://122.51.10.98:8082/api"
} else {
  # 与访问域名同源，避免 CORS
  $API_URL = "http://translate.air-inc.top/api"
}

# API Key（与服务端 .env 的 API_KEY 一致，用于鉴权）
$API_KEY = "af9a7d9ac145f539c84616012f9398b121cee1ad65005f3fc055f056aa4fd3fc"
