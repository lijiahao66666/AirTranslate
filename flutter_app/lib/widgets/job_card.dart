import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../models/job.dart';

class JobCard extends StatefulWidget {
  final Job job;
  final VoidCallback? onDownload;
  final VoidCallback? onTap;

  const JobCard({
    super.key,
    required this.job,
    this.onDownload,
    this.onTap,
  });

  @override
  State<JobCard> createState() => _JobCardState();
}

class _JobCardState extends State<JobCard> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final job = widget.job;
    final progress = job.progress;
    final state = progress?.state ?? 'CREATED';
    final percent = progress?.percent ?? 0;

    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
      child: InkWell(
        borderRadius: BorderRadius.circular(16),
        onTap: () {
          if (progress != null && (progress.isRunning || progress.isFailed)) {
            setState(() => _expanded = !_expanded);
          }
          widget.onTap?.call();
        },
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // 标题行
              Row(
                children: [
                  const Text('📖', style: TextStyle(fontSize: 20)),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      job.sourceFileName.replaceAll('.epub', ''),
                      style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 6),

              // 标签行
              Text(
                '${job.engineLabel} · ${job.langPairLabel} · ${job.outputLabel}',
                style: TextStyle(fontSize: 13, color: cs.onSurfaceVariant),
              ),
              const SizedBox(height: 10),

              // 状态行
              _buildStatusRow(cs, state, percent, progress),

              // 展开详情
              if (_expanded && progress != null) ...[
                const Divider(height: 20),
                _buildDetail(cs, progress, job),
              ],
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildStatusRow(ColorScheme cs, String state, int percent, JobProgress? progress) {
    if (progress?.isDone == true) {
      return Row(
        children: [
          Icon(Icons.check_circle, color: Colors.green.shade600, size: 20),
          const SizedBox(width: 6),
          Text('翻译完成', style: TextStyle(color: Colors.green.shade600, fontWeight: FontWeight.w500)),
          const Spacer(),
          if (widget.onDownload != null)
            FilledButton.icon(
              onPressed: widget.onDownload,
              icon: const Icon(Icons.download, size: 18),
              label: const Text('下载'),
              style: FilledButton.styleFrom(
                minimumSize: const Size(0, 36),
                padding: const EdgeInsets.symmetric(horizontal: 16),
              ),
            ),
        ],
      );
    }

    if (progress?.isFailed == true) {
      return Row(
        children: [
          Icon(Icons.error, color: cs.error, size: 20),
          const SizedBox(width: 6),
          Expanded(
            child: Text(
              '翻译失败${progress?.refundedPoints != null ? ' (已退还${NumberFormat("#,###").format(progress!.refundedPoints)}积分)' : ''}',
              style: TextStyle(color: cs.error, fontWeight: FontWeight.w500),
            ),
          ),
          Icon(Icons.expand_more, color: cs.onSurfaceVariant, size: 20),
        ],
      );
    }

    if (state == 'CREATED' || state == 'UPLOADED') {
      return Row(
        children: [
          SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: cs.primary)),
          const SizedBox(width: 8),
          Text('排队中...', style: TextStyle(color: cs.onSurfaceVariant)),
        ],
      );
    }

    // 进行中
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        ClipRRect(
          borderRadius: BorderRadius.circular(4),
          child: LinearProgressIndicator(
            value: percent / 100.0,
            minHeight: 6,
            backgroundColor: cs.surfaceContainerHighest,
          ),
        ),
        const SizedBox(height: 6),
        Row(
          children: [
            Text(
              '${progress?.stateLabel ?? ""} $percent%',
              style: TextStyle(fontSize: 13, color: cs.onSurfaceVariant),
            ),
            if (progress?.chapterIndex != null && progress?.chapterTotal != null) ...[
              const SizedBox(width: 8),
              Text(
                '第 ${progress!.chapterIndex}/${progress.chapterTotal} 章',
                style: TextStyle(fontSize: 13, color: cs.onSurfaceVariant),
              ),
            ],
            const Spacer(),
            Icon(_expanded ? Icons.expand_less : Icons.expand_more, size: 20, color: cs.onSurfaceVariant),
          ],
        ),
      ],
    );
  }

  Widget _buildDetail(ColorScheme cs, JobProgress progress, Job job) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (progress.chapterIndex != null)
          _detailRow(cs, '📌', '当前', '第 ${progress.chapterIndex} 章 / 共 ${progress.chapterTotal} 章'),
        if (job.pointsDeducted > 0)
          _detailRow(cs, '💰', '积分', '预扣 ${NumberFormat("#,###").format(job.pointsDeducted)} 积分'),
        if (progress.isFailed && progress.error != null)
          _detailRow(cs, '❌', '错误', progress.error!.message),
      ],
    );
  }

  Widget _detailRow(ColorScheme cs, String icon, String label, String value) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Row(
        children: [
          Text(icon, style: const TextStyle(fontSize: 14)),
          const SizedBox(width: 6),
          Text('$label: ', style: TextStyle(fontSize: 13, color: cs.onSurfaceVariant)),
          Expanded(
            child: Text(value, style: TextStyle(fontSize: 13, color: cs.onSurface)),
          ),
        ],
      ),
    );
  }
}
