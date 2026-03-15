# AirTranslate 鏋勫缓閰嶇疆 - Web / Android / iOS 鍏辩敤
# 鍒囨崲澶囨鍓?鍚庯細淇敼 $UseIpMode锛屾墍鏈夋墦鍖呰剼鏈細鍚屾浣跨敤
$UseIpMode = $false   # 澶囨鍓嶆敼涓?$true

if ($UseIpMode) {
  $API_URL = "http://122.51.10.98:8082/api"
} else {
  $API_URL = "https://translate.air-inc.top/api"
}

# API Key锛堜笌鏈嶅姟绔?.env 鐨?API_KEY 涓€鑷达紝鐢ㄤ簬閴存潈锛?
$API_KEY = "af9a7d9ac145f539c84616012f9398b121cee1ad65005f3fc055f056aa4fd3fc"
$BUILD_NUMBER = $env:BUILD_NUMBER
if (-not $BUILD_NUMBER) { $BUILD_NUMBER = (Get-Date -Format "yyyyMMddHH") }
