import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_animate/flutter_animate.dart';
import 'package:intl/intl.dart';
import 'package:url_launcher/url_launcher.dart';
import '../models/job.dart';
import '../services/api_service.dart';
import '../theme/app_theme.dart';
import '../widgets/job_card.dart';
import '../widgets/wallet_sheet.dart';
import 'create_job_page.dart';

class HomePage extends StatefulWidget {
  const HomePage({super.key});

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  final _api = ApiService();
  List<Job> _jobs = [];
  int _balance = 0;
  bool _loading = true;
  Timer? _pollTimer;

  @override
  void initState() {
    super.initState();
    _loadData();
    _pollTimer = Timer.periodic(const Duration(seconds: 8), (_) => _refreshJobs());
  }

  @override
  void dispose() {
    _pollTimer?.cancel();
    super.dispose();
  }

  Future<void> _loadData() async {
    setState(() => _loading = true);
    try {
      final results = await Future.wait([
        _api.listJobs(),
        _api.getBalance(),
      ]);
      if (mounted) {
        setState(() {
          _jobs = results[0] as List<Job>;
          _balance = results[1] as int;
          _loading = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() => _loading = false);
        _showError('加载失败: $e');
      }
    }
  }

  Future<void> _refreshJobs() async {
    try {
      final jobs = await _api.listJobs();
      final balance = await _api.getBalance();
      if (mounted) {
        setState(() {
          _jobs = jobs;
          _balance = balance;
        });
      }
    } catch (_) {}
  }

  Future<void> _download(Job job) async {
    try {
      final url = await _api.getDownloadUrl(job.jobId, output: job.output);
      await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
    } catch (e) {
      _showError('获取下载链接失败: $e');
    }
  }

  void _showError(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(msg), behavior: SnackBarBehavior.floating),
    );
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final fmt = NumberFormat('#,###');

    return Scaffold(
      body: RefreshIndicator(
        onRefresh: _loadData,
        child: CustomScrollView(
          slivers: [
            // 渐变顶栏
            SliverAppBar(
              expandedHeight: 100,
              pinned: true,
              flexibleSpace: FlexibleSpaceBar(
                background: Container(
                  decoration: BoxDecoration(
                    gradient: LinearGradient(
                      colors: AppTheme.gradientColors,
                      begin: Alignment.topLeft,
                      end: Alignment.bottomRight,
                    ),
                  ),
                ),
              ),
              title: const Text('AirTranslate', style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
              actions: [
                // 积分 + 充值按钮
                GestureDetector(
                  onTap: () => WalletSheet.show(context, _balance, () => _refreshJobs()),
                  child: Container(
                    margin: const EdgeInsets.only(right: 16),
                    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
                    decoration: BoxDecoration(
                      color: Colors.white.withOpacity(0.2),
                      borderRadius: BorderRadius.circular(20),
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const Text('🪙 ', style: TextStyle(fontSize: 14)),
                        Text(fmt.format(_balance), style: const TextStyle(
                          color: Colors.white, fontWeight: FontWeight.w600, fontSize: 14,
                        )),
                        const SizedBox(width: 4),
                        const Text('充值 ▸', style: TextStyle(color: Colors.white70, fontSize: 12)),
                      ],
                    ),
                  ),
                ),
              ],
            ),

            // 标题
            SliverToBoxAdapter(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(20, 20, 20, 8),
                child: Text('我的翻译', style: TextStyle(
                  fontSize: 18, fontWeight: FontWeight.w600, color: cs.onSurface,
                )),
              ),
            ),

            // 内容
            if (_loading)
              const SliverFillRemaining(
                child: Center(child: CircularProgressIndicator()),
              )
            else if (_jobs.isEmpty)
              SliverFillRemaining(
                child: Center(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(Icons.translate, size: 64, color: cs.outlineVariant),
                      const SizedBox(height: 16),
                      Text('还没有翻译任务', style: TextStyle(fontSize: 16, color: cs.onSurfaceVariant)),
                      const SizedBox(height: 8),
                      Text('点击下方按钮开始翻译', style: TextStyle(fontSize: 14, color: cs.outlineVariant)),
                    ],
                  ),
                ),
              )
            else
              SliverList(
                delegate: SliverChildBuilderDelegate(
                  (context, index) {
                    final job = _jobs[index];
                    return JobCard(
                      job: job,
                      onDownload: job.progress?.isDone == true ? () => _download(job) : null,
                    ).animate().fadeIn(duration: 300.ms, delay: (index * 50).ms).slideY(begin: 0.05, end: 0);
                  },
                  childCount: _jobs.length,
                ),
              ),

            // 底部留白
            const SliverToBoxAdapter(child: SizedBox(height: 80)),
          ],
        ),
      ),

      // FAB
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () async {
          final result = await Navigator.push(
            context,
            MaterialPageRoute(builder: (_) => const CreateJobPage()),
          );
          if (result == true) {
            _loadData();
          }
        },
        icon: const Icon(Icons.add),
        label: const Text('新建翻译任务'),
      ),
      floatingActionButtonLocation: FloatingActionButtonLocation.centerFloat,
    );
  }
}
