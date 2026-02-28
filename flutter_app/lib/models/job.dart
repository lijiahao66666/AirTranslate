class Job {
  final String jobId;
  final String engineType; // "MACHINE" or "AI"
  final String output; // "BILINGUAL" or "TRANSLATED_ONLY"
  final String deviceId;
  final String sourceLang;
  final String targetLang;
  final String sourceFileName;
  final int charCount;
  final bool useContext;
  final bool useGlossary;
  final int pointsDeducted;
  final String createdAt;
  final String? coverImage;
  final JobProgress? progress;

  Job({
    required this.jobId,
    required this.engineType,
    required this.output,
    required this.deviceId,
    required this.sourceLang,
    required this.targetLang,
    required this.sourceFileName,
    this.charCount = 0,
    this.useContext = false,
    this.useGlossary = false,
    this.pointsDeducted = 0,
    required this.createdAt,
    this.coverImage,
    this.progress,
  });

  factory Job.fromJson(Map<String, dynamic> json) {
    final progressJson = json['progress'] as Map<String, dynamic>?;
    return Job(
      jobId: json['jobId'] ?? '',
      engineType: json['engineType'] ?? 'MACHINE',
      output: json['output'] ?? 'BILINGUAL',
      deviceId: json['deviceId'] ?? '',
      sourceLang: json['sourceLang'] ?? 'auto',
      targetLang: json['targetLang'] ?? '',
      sourceFileName: json['sourceFileName'] ?? '',
      charCount: (json['charCount'] ?? 0) is int ? json['charCount'] : int.tryParse('${json['charCount']}') ?? 0,
      useContext: json['useContext'] == true,
      useGlossary: json['useGlossary'] == true,
      pointsDeducted: (json['pointsDeducted'] ?? 0) is int ? json['pointsDeducted'] : int.tryParse('${json['pointsDeducted']}') ?? 0,
      createdAt: json['createdAt'] ?? '',
      coverImage: json['coverImage'],
      progress: progressJson != null ? JobProgress.fromJson(progressJson) : null,
    );
  }

  String get engineLabel => engineType == 'AI' ? 'AI翻译' : '机器翻译';
  String get outputLabel => output == 'BILINGUAL' ? '双语' : '纯译文';

  String get langPairLabel {
    final src = _langName(sourceLang);
    final tgt = _langName(targetLang);
    return '$src→$tgt';
  }

  static String _langName(String code) {
    const map = {
      'auto': '自动', 'zh': '中文', 'zh-cn': '中文', 'zh-tw': '繁体中文',
      'en': '英语', 'ja': '日语', 'ko': '韩语', 'fr': '法语',
      'de': '德语', 'es': '西班牙语', 'ru': '俄语', 'pt': '葡萄牙语',
      'it': '意大利语', 'ar': '阿拉伯语', 'th': '泰语', 'vi': '越南语',
    };
    return map[code.toLowerCase()] ?? code;
  }
}

class JobProgress {
  final String state;
  final int percent;
  final String? engineType;
  final String? output;
  final int? chapterIndex;
  final int? chapterTotal;
  final int? refundedPoints;
  final JobError? error;

  JobProgress({
    required this.state,
    required this.percent,
    this.engineType,
    this.output,
    this.chapterIndex,
    this.chapterTotal,
    this.refundedPoints,
    this.error,
  });

  factory JobProgress.fromJson(Map<String, dynamic> json) {
    final errJson = json['error'] as Map<String, dynamic>?;
    return JobProgress(
      state: json['state'] ?? 'CREATED',
      percent: (json['percent'] ?? 0) is int ? json['percent'] : int.tryParse('${json['percent']}') ?? 0,
      engineType: json['engineType'],
      output: json['output'],
      chapterIndex: json['chapterIndex'],
      chapterTotal: json['chapterTotal'],
      refundedPoints: json['refundedPoints'],
      error: errJson != null ? JobError.fromJson(errJson) : null,
    );
  }

  bool get isDone => state == 'DONE';
  bool get isFailed => state == 'FAILED';
  bool get isRunning => !isDone && !isFailed && state != 'CREATED';

  String get stateLabel {
    switch (state) {
      case 'CREATED': return '已创建';
      case 'UPLOADED': return '排队中';
      case 'PARSING': return '解析中';
      case 'TRANSLATING': return '翻译中';
      case 'PACKAGING': return '打包中';
      case 'UPLOADING_RESULT': return '上传中';
      case 'DONE': return '已完成';
      case 'FAILED': return '失败';
      default: return state;
    }
  }
}

class JobError {
  final String code;
  final String message;

  JobError({required this.code, required this.message});

  factory JobError.fromJson(Map<String, dynamic> json) {
    return JobError(
      code: json['code'] ?? '',
      message: json['message'] ?? '',
    );
  }
}
