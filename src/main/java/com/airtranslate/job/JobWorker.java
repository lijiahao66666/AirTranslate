package com.airtranslate.job;

import com.airtranslate.job.model.JobSpec;
import com.airtranslate.scf.ScfClient;
import com.airtranslate.translators.AzureTranslator;
import com.airtranslate.translators.GoogleTranslator;
import com.airtranslate.translators.LocalHyTranslator;
import com.airtranslate.utils.HtmlUtil;
import com.airtranslate.utils.ZipUtil;
import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONArray;
import com.alibaba.fastjson2.JSONObject;
import com.airtranslate.billing.BillingSettings;
import com.airtranslate.billing.PointsInsufficientException;
import com.airtranslate.enums.JobState;
import com.airtranslate.enums.LanguageType;
import com.airtranslate.enums.TranslationEngine;
import com.airtranslate.enums.TranslationOutput;
import com.airtranslate.enums.TranslationMode;
import com.airtranslate.job.model.JobBilling;
import com.airtranslate.job.model.JobProgress;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.util.CollectionUtils;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.IntStream;

@Slf4j
@Component
@RequiredArgsConstructor
@ConditionalOnProperty(prefix = "job.worker", name = "enabled", havingValue = "true")
@ConditionalOnProperty(prefix = "scf", name = "baseUrl")
public class JobWorker {

    private static final Pattern TARGET_BLOCK = Pattern.compile("<target>([\\s\\S]*?)</target>", Pattern.CASE_INSENSITIVE);
    private static final Pattern SEG_BLOCK = Pattern.compile("<seg\\s+id\\s*=\\s*\"(\\d+)\"\\s*>([\\s\\S]*?)</seg>", Pattern.CASE_INSENSITIVE);

    private final ScfClient scfClient;
    private final LocalHyTranslator localHyTranslator;
    private final AzureTranslator azureTranslator;
    private final GoogleTranslator googleTranslator;
    private final BillingSettings billingSettings;

    @Scheduled(fixedDelayString = "${job.worker.pollDelayMs:1000}")
    public void poll() {
        String jobId = scfClient.pollNextJobId();
        if (jobId == null || jobId.isBlank()) {
            return;
        }
        process(jobId.trim());
    }

    private void process(String jobId) {
        Path tempDir = null;
        try {
            JobSpec job = scfClient.getJobSpec(jobId);
            JobProgress progress = scfClient.getProgress(jobId);
            if (job == null || progress == null) {
                return;
            }
            if (progress.getState() == JobState.DONE || progress.getState() == JobState.CANCELED) {
                return;
            }
            if (progress.getState() != JobState.UPLOADED && progress.getState() != JobState.CREATED) {
                return;
            }

            updateProgress(jobId, p -> {
                p.setState(JobState.PARSING);
                p.setPercent(Math.max(p.getPercent(), 1));
            });

            tempDir = Files.createTempDirectory("job_" + jobId + "_");
            Path sourceEpub = tempDir.resolve("source.epub");
            String sourceUrl = scfClient.getSourceUrl(jobId);
            if (sourceUrl == null || sourceUrl.isBlank()) {
                throw new IllegalStateException("获取sourceUrl失败");
            }
            downloadToPath(sourceUrl, sourceEpub);

            Path unpackDir = tempDir.resolve("unpacked");
            Files.createDirectories(unpackDir);
            ZipUtil.unzipEpub(sourceEpub.toString(), unpackDir);

            TranslationEngine engine = job.getEngine() == null ? TranslationEngine.HY : job.getEngine();
            TranslationOutput output = job.getOutput() == null ? TranslationOutput.TRANSLATED_ONLY : job.getOutput();
            TranslationMode mode = job.getMode() == null ? TranslationMode.PARAGRAPH : job.getMode();
            if (mode == TranslationMode.CHAPTER && engine != TranslationEngine.HY) {
                mode = TranslationMode.PARAGRAPH;
            }
            String glossaryPrompt = engine == TranslationEngine.HY ? buildGlossaryPrompt(job.getGlossaryCosKey()) : "";
            JobBilling billing = initBilling(jobId, job, engine);

            billEstimateIfNeeded(jobId, billing, unpackDir);
            TranslationMode finalMode = mode;
            updateProgress(jobId, p -> {
                p.setEngine(engine);
                p.setMode(finalMode);
                p.setOutput(output);
                p.setState(JobState.TRANSLATING);
            });
            HtmlUtil.processHtmlFiles(unpackDir, output, ctx -> {
                int percent = ctx.getProgressPercent();
                int chapterIndex = ctx.getChapterIndex();
                int chapterTotal = ctx.getChapterTotal();
                List<String> sources = ctx.getSources();

                updateProgress(jobId, p -> {
                    p.setPercent(Math.min(99, Math.max(p.getPercent(), percent)));
                    JobProgress.ChapterProgress cp = new JobProgress.ChapterProgress();
                    cp.setIndex(chapterIndex);
                    cp.setTotal(chapterTotal);
                    p.setCurrentChapter(cp);
                });

                if (engine == TranslationEngine.AZURE) {
                    return azureTranslator.translate(sources, job.getTargetLang(), true);
                }
                if (engine == TranslationEngine.GOOGLE) {
                    return googleTranslator.translate(sources, job.getTargetLang(), true);
                }

                if (finalMode == TranslationMode.CHAPTER) {
                    return translateHyChapter(job.getTargetLang(), sources, glossaryPrompt);
                }

                if (!glossaryPrompt.isBlank()) {
                    return translateHyParagraph(job.getTargetLang(), sources, glossaryPrompt);
                }

                return localHyTranslator.translate(sources, job.getTargetLang(), true);
            });

            updateProgress(jobId, p -> p.setState(JobState.PACKAGING));
            Path resultEpub = tempDir.resolve("result.epub");
            ZipUtil.zipEpub(unpackDir, resultEpub.toString());

            updateProgress(jobId, p -> p.setState(JobState.UPLOADING_RESULT));
            String uploadUrl = scfClient.getResultUploadUrl(jobId, output == null ? null : output.name());
            if (uploadUrl == null || uploadUrl.isBlank()) {
                throw new IllegalStateException("获取resultUrl失败");
            }
            uploadFile(uploadUrl, "application/epub+zip", resultEpub);

            updateProgress(jobId, p -> {
                p.setState(JobState.DONE);
                p.setPercent(100);
            });
        } catch (Exception e) {
            log.error("process job error, jobId={}", jobId, e);
            updateProgress(jobId, p -> {
                p.setState(JobState.FAILED);
                JobProgress.JobError error = new JobProgress.JobError();
                error.setCode(e instanceof PointsInsufficientException ? "POINTS_INSUFFICIENT" : "JOB_FAILED");
                error.setMessage(e.getMessage());
                p.setError(error);
            });
        } finally {
            deleteDirectory(tempDir);
        }
    }

    private JobBilling initBilling(String jobId, JobSpec job, TranslationEngine engine) {
        if (engine != TranslationEngine.HY) {
            return null;
        }
        JobBilling billing = scfClient.getBilling(jobId);
        if (billing == null) {
            billing = new JobBilling();
            billing.setJobId(jobId);
            billing.setDeviceId(job.getDeviceId());
            billing.setUnitChars(billingSettings.getUnitChars());
            billing.setUnitCost(billingSettings.getUnitCost());
            billing.setTotalCost(0);
            billing.setUpdatedAt(Instant.now());
            scfClient.putBilling(jobId, billing);
        }
        return billing;
    }

    private void billEstimateIfNeeded(String jobId, JobBilling billing, Path unpackDir) throws java.io.IOException {
        if (billing == null) {
            return;
        }
        String deviceId = billing.getDeviceId();
        if (deviceId == null || deviceId.isBlank()) {
            throw new IllegalStateException("deviceId缺失，无法扣费");
        }
        if (billing.getEstimatedAt() != null) {
            return;
        }
        if (billing.getChapters() != null && !billing.getChapters().isEmpty()) {
            return;
        }
        if (billing.getTotalCost() != null && billing.getTotalCost() > 0) {
            return;
        }

        int chars = HtmlUtil.countTranslatableChars(unpackDir);
        int cost = computeCost(chars, billingSettings.getUnitChars(), billingSettings.getUnitCost());
        if (cost > 0) {
            scfClient.deductPoints(deviceId, cost);
        }
        Instant now = Instant.now();
        billing.setEstimatedChars(chars);
        billing.setEstimatedCost(cost);
        billing.setEstimatedAt(now);
        billing.setTotalCost(cost);
        billing.setUpdatedAt(now);
        scfClient.putBilling(jobId, billing);
    }

    private static int computeCost(int chars, int unitChars, int unitCost) {
        if (chars <= 0) {
            return 0;
        }
        int uc = unitChars <= 0 ? 1000 : unitChars;
        int price = unitCost <= 0 ? 1 : unitCost;
        int units = (chars + uc - 1) / uc;
        long cost = (long) units * (long) price;
        return cost > Integer.MAX_VALUE ? Integer.MAX_VALUE : (int) cost;
    }

    private static int countChars(List<String> sources) {
        if (sources == null || sources.isEmpty()) {
            return 0;
        }
        long sum = 0;
        for (String s : sources) {
            if (s == null || s.isEmpty()) {
                continue;
            }
            sum += s.codePointCount(0, s.length());
        }
        return sum > Integer.MAX_VALUE ? Integer.MAX_VALUE : (int) sum;
    }

    private List<String> translateHyParagraph(String targetLang, List<String> sources, String glossaryPrompt) {
        if (CollectionUtils.isEmpty(sources)) {
            return List.of();
        }
        String targetLanguage = targetLang;
        try {
            targetLanguage = LanguageType.valueOfLangCode(targetLang).getDesc();
        } catch (Exception ignored) {
        }

        String finalTargetLanguage = targetLanguage;
        return sources.stream()
                .map(s -> {
                    String prompt = glossaryPrompt
                            + "将以下文本翻译为" + finalTargetLanguage + "，注意只需要输出翻译后的结果，不要额外解释：\n\n"
                            + escapeForPrompt(s);
                    String raw = localHyTranslator.completePrompt(prompt);
                    if (raw == null) {
                        return localHyTranslator.translate(s, targetLang, true);
                    }
                    return raw.replace("\"", "'");
                })
                .toList();
    }

    private List<String> translateHyChapter(String targetLang, List<String> sources, String glossaryPrompt) {
        if (CollectionUtils.isEmpty(sources)) {
            return List.of();
        }

        String targetLanguage = targetLang;
        try {
            targetLanguage = LanguageType.valueOfLangCode(targetLang).getDesc();
        } catch (Exception ignored) {
        }

        String src = IntStream.range(0, sources.size())
                .mapToObj(i -> "<seg id=\"" + i + "\">" + escapeXml(sources.get(i)) + "</seg>")
                .reduce((a, b) -> a + "\n" + b)
                .orElse("");

        String prompt = glossaryPrompt
                + "将以下<source></source>之间的文本翻译为" + targetLanguage + "，注意只需要输出翻译后的结果，不要额外解释，原文中的<seg></seg>标签表示段落分隔，需要在译文中相应的位置尽量保留该标签。输出格式为：<target>str</target>\n\n<source>"
                + src
                + "</source>";

        String raw = localHyTranslator.completePrompt(prompt);
        if (raw == null) {
            return localHyTranslator.translate(sources, targetLang, true);
        }

        String targetBlock = extractTarget(raw);
        String[] arr = new String[sources.size()];
        Matcher matcher = SEG_BLOCK.matcher(targetBlock);
        while (matcher.find()) {
            int idx;
            try {
                idx = Integer.parseInt(matcher.group(1));
            } catch (Exception ignored) {
                continue;
            }
            if (idx < 0 || idx >= arr.length) {
                continue;
            }
            arr[idx] = matcher.group(2) == null ? "" : matcher.group(2).trim();
        }

        return IntStream.range(0, sources.size())
                .mapToObj(i -> {
                    String t = arr[i];
                    if (t == null || t.isBlank()) {
                        return localHyTranslator.translate(sources.get(i), targetLang, true);
                    }
                    return t.replace("\"", "'");
                })
                .toList();
    }

    private static String extractTarget(String raw) {
        Matcher matcher = TARGET_BLOCK.matcher(raw);
        if (matcher.find()) {
            return matcher.group(1) == null ? "" : matcher.group(1).trim();
        }
        return raw;
    }

    private static String escapeXml(String s) {
        if (s == null) {
            return "";
        }
        return s.replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;")
                .replace("\"", "&quot;")
                .replace("'", "&apos;");
    }

    private static String escapeForPrompt(String s) {
        if (s == null) {
            return "";
        }
        return s.replace("\\", "\\\\")
                .replace("\n", "\\n")
                .replace("\r", "\\r")
                .replace("\t", "\\t");
    }

    private String buildGlossaryPrompt(String glossaryCosKey) {
        if (glossaryCosKey == null || glossaryCosKey.isBlank()) {
            return "";
        }
        try {
            String content = scfClient.getObjectString(glossaryCosKey);
            if (content == null || content.isBlank()) {
                return "";
            }

            Object parsed = JSON.parse(content);
            StringBuilder sb = new StringBuilder();
            sb.append("参考下面的翻译：\n");

            int limit = 50;
            int count = 0;

            if (parsed instanceof JSONObject obj) {
                for (Map.Entry<String, Object> entry : obj.entrySet()) {
                    if (count >= limit) {
                        break;
                    }
                    String source = entry.getKey();
                    String target = entry.getValue() == null ? "" : String.valueOf(entry.getValue());
                    if (source == null || source.isBlank() || target.isBlank()) {
                        continue;
                    }
                    sb.append(source).append(" 翻译成 ").append(target).append("\n");
                    count++;
                }
            } else if (parsed instanceof JSONArray arr) {
                for (Object item : arr) {
                    if (count >= limit) {
                        break;
                    }
                    if (!(item instanceof JSONObject it)) {
                        continue;
                    }
                    String source = it.getString("sourceTerm");
                    String target = it.getString("targetTerm");
                    if (source == null || target == null) {
                        source = it.getString("source");
                        target = it.getString("target");
                    }
                    if (source == null || source.isBlank() || target == null || target.isBlank()) {
                        continue;
                    }
                    sb.append(source).append(" 翻译成 ").append(target).append("\n");
                    count++;
                }
            } else {
                return "";
            }
            sb.append("\n");
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }

    private void updateProgress(String jobId, java.util.function.Consumer<JobProgress> updater) {
        try {
            JobProgress progress = scfClient.getProgress(jobId);
            if (progress == null) {
                return;
            }
            updater.accept(progress);
            progress.setUpdatedAt(Instant.now());
            scfClient.putProgress(jobId, progress);
        } catch (Exception e) {
            log.error("update progress error, jobId={}", jobId, e);
        }
    }

    private static void downloadToPath(String url, Path path) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) URI.create(url).toURL().openConnection();
        conn.setRequestMethod("GET");
        conn.setInstanceFollowRedirects(true);
        int code = conn.getResponseCode();
        if (code < 200 || code >= 300) {
            throw new IllegalStateException("下载失败: " + code);
        }
        try (InputStream in = conn.getInputStream(); OutputStream out = Files.newOutputStream(path)) {
            in.transferTo(out);
        } finally {
            conn.disconnect();
        }
    }

    private static void uploadFile(String url, String contentType, Path file) throws Exception {
        long size = Files.size(file);
        HttpURLConnection conn = (HttpURLConnection) URI.create(url).toURL().openConnection();
        conn.setRequestMethod("PUT");
        conn.setDoOutput(true);
        if (contentType != null && !contentType.isBlank()) {
            conn.setRequestProperty("Content-Type", contentType);
        }
        conn.setFixedLengthStreamingMode(size);
        try (OutputStream out = conn.getOutputStream(); InputStream in = Files.newInputStream(file)) {
            in.transferTo(out);
        }
        int code = conn.getResponseCode();
        if (code < 200 || code >= 300) {
            throw new IllegalStateException("上传失败: " + code);
        }
        conn.disconnect();
    }

    private void deleteDirectory(Path directory) {
        if (directory == null) {
            return;
        }
        try {
            if (Files.exists(directory)) {
                Files.walk(directory)
                        .sorted(Comparator.reverseOrder())
                        .forEach(path -> {
                            try {
                                Files.deleteIfExists(path);
                            } catch (Exception ignored) {
                            }
                        });
            }
        } catch (Exception ignored) {
        }
    }
}
