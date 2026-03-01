import 'package:flutter/material.dart';
import 'services/api_service.dart';
import 'services/auth_service.dart';
import 'theme/app_theme.dart';
import 'pages/home_page.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await ApiService().init();
  await AuthService.init();
  // 初始化积分（deviceId 即可，无需登录）
  try { await ApiService().initBalance(); } catch (_) {}
  runApp(const AirTranslateApp());
}

class AirTranslateApp extends StatelessWidget {
  const AirTranslateApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: '灵译',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.light(),
      darkTheme: AppTheme.dark(),
      themeMode: ThemeMode.system,
      home: const HomePage(),
    );
  }
}
