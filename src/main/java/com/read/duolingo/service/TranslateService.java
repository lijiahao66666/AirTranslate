package com.read.duolingo.service;

import com.read.duolingo.entity.OfflineTranslateTemp;
import com.read.duolingo.enums.LanguageType;
import com.read.duolingo.enums.TranslationStatus;
import com.read.duolingo.enums.TranslatorType;
import com.read.duolingo.repo.TranslateRepository;
import com.read.duolingo.service.translators.Translator;
import com.read.duolingo.utils.FutureUtil;
import com.read.duolingo.utils.HtmlUtil;
import com.read.duolingo.utils.ZipUtil;
import jakarta.annotation.Resource;
import lombok.extern.slf4j.Slf4j;
import org.springframework.context.annotation.Conditional;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;
import org.springframework.stereotype.Service;
import org.springframework.util.CollectionUtils;
import org.springframework.web.multipart.MultipartFile;

import java.io.*;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ThreadPoolExecutor;

@Slf4j
@Service
public class TranslateService {

    @Resource
    private TranslateRepository translateRepository;
    @Resource
    private List<Translator> translators;


    private static final String TRANSLATION = System.getProperty("user.dir") + "/translation";
    private static final TranslatorType offlineTranslateUseTranslatorType = TranslatorType.LOCAL_SEED_X;

    private final ThreadPoolTaskExecutor offlineLlmTaskExecutor = new ThreadPoolTaskExecutor();
    {
        offlineLlmTaskExecutor.setCorePoolSize(20);
        offlineLlmTaskExecutor.setMaxPoolSize(20);
        offlineLlmTaskExecutor.setQueueCapacity(0);
        offlineLlmTaskExecutor.setRejectedExecutionHandler(new ThreadPoolExecutor.DiscardPolicy());
        offlineLlmTaskExecutor.initialize();
    }

    /**
     * 离线翻译任务
     */
    //    @Scheduled(fixedDelay = 1000)
    public void offlineTranslate() {
        // 获取翻译任务
        OfflineTranslateTemp offlineTranslateTemp = translateRepository.getOfflineTranslateTempByTranslationStatus(List.of(TranslationStatus.NOT_START.getValue()));
        if (offlineTranslateTemp == null) {
            return;
        }
        // 离线翻译
        offlineLlmTaskExecutor.execute(() -> offlineTranslate(offlineTranslateTemp));
    }



    private void offlineTranslate(OfflineTranslateTemp offlineTranslateTemp) {
        if (offlineTranslateTemp == null || !Objects.equals(offlineTranslateTemp.getTranslationStatus(), TranslationStatus.NOT_START.getValue())) {
            return;
        }
        offlineTranslateTemp.setTranslationStatus(TranslationStatus.TRANSLATING.getValue());
        translateRepository.updateOfflineTranslateTemp(offlineTranslateTemp);
        Path tempDir = null;
        try {
            tempDir = Files.createTempDirectory("translate_temp");
            // 解压 EPUB 文件
            ZipUtil.unzipEpub(getFileDir(offlineTranslateTemp.getId(), true) + offlineTranslateTemp.getFileName(), tempDir);
            // 处理 HTML 文件
            HtmlUtil.processHtmlFiles(tempDir, (progress, sources) -> {
                List<String> targets = translateSource(sources, offlineTranslateTemp.getLangCode(), false, offlineTranslateUseTranslatorType.name());
                offlineTranslateTemp.setProgress(progress);
                translateRepository.updateOfflineTranslateTemp(offlineTranslateTemp);
                return targets;
            });
            // 重新压缩为 EPUB
            ZipUtil.zipEpub(tempDir, getFileDir(offlineTranslateTemp.getId(), false) + offlineTranslateTemp.getFileName());
            offlineTranslateTemp.setTranslationStatus(TranslationStatus.COMPLETED.getValue());
            offlineTranslateTemp.setProgress(100);
            translateRepository.updateOfflineTranslateTemp(offlineTranslateTemp);
        } catch (Exception e) {
            log.error("离线翻译书籍失败", e);
            // 重试
            offlineTranslateTemp.setTranslationStatus(TranslationStatus.NOT_START.getValue());
            if(Optional.ofNullable(offlineTranslateTemp.getFailCount()).orElse(0) > 3){
                offlineTranslateTemp.setTranslationStatus(TranslationStatus.FAILED.getValue());
            }
            offlineTranslateTemp.setFailCount(Optional.ofNullable(offlineTranslateTemp.getFailCount()).orElse(0) + 1);
            translateRepository.updateOfflineTranslateTemp(offlineTranslateTemp);
        } finally {
            // 清理临时文件
            deleteDirectory(tempDir);
        }
    }

    public List<String> translateSource(List<String> sourceList, String langCode, boolean isOnline, String translator) {
        if (CollectionUtils.isEmpty(sourceList)) {
            return new ArrayList<>();
        }
        // 校验langCode
        LanguageType.valueOfLangCode(langCode);
        // 校验translator
        Translator realTranslator = translators.stream().filter(t -> t.getTranslatorType().name().equals(translator)).findFirst().orElseThrow(() -> new IllegalArgumentException("translator is not support"));
        // 使用seed-x翻译
        List<String> targets = realTranslator.translate(sourceList, langCode, isOnline);
        log.info("翻译结果translateResult: {}", targets);
        return targets;
    }

    public Long submitOfflineTranslate(String langCode, MultipartFile file) {
        // 校验langCode
        LanguageType.valueOfLangCode(langCode);
        OfflineTranslateTemp offlineTranslateTemp = new OfflineTranslateTemp();
        offlineTranslateTemp.setTranslationStatus(TranslationStatus.NOT_START.getValue());
        offlineTranslateTemp.setLangCode(langCode);
        offlineTranslateTemp.setProgress(0);
        Long offlineTranslateTempId = translateRepository.insertOfflineTranslateTemp(offlineTranslateTemp);
        String fileName = upload(offlineTranslateTempId, file, true);
        offlineTranslateTemp.setFileName(fileName);
        translateRepository.updateOfflineTranslateTemp(offlineTranslateTemp);
        // 保存到书籍
        return offlineTranslateTempId;
    }

    public Integer queryOfflineTranslateResult(Long offlineTranslateTempId) {
        if (offlineTranslateTempId == null) {
            throw new IllegalArgumentException("offlineTranslateTempId is null");
        }
        OfflineTranslateTemp offlineTranslateTemp = translateRepository.findOfflineTranslateTempById(offlineTranslateTempId);
        if (offlineTranslateTemp == null) {
            return null;
        }
        return offlineTranslateTemp.getProgress();
    }

    /**
     * 下载文件地址
     * @param offlineTranslateTempId 书籍id
     * @return epub文件路径
     */
    public String getDownloadPath(Long offlineTranslateTempId) {
        if(offlineTranslateTempId == null) {
            throw new RuntimeException("离线翻译任务id不能为空");
        }
        // 从数据库查询书籍信息
        OfflineTranslateTemp offlineTranslateTemp = translateRepository.findOfflineTranslateTempById(offlineTranslateTempId);
        if(offlineTranslateTemp == null) {
            throw new RuntimeException("离线翻译任务不存在");
        }
        return getFileDir(offlineTranslateTempId, false) + offlineTranslateTemp.getFileName();
    }

    public String upload(Long offlineTranslateTempId, MultipartFile file, boolean isSource) {
        if(file == null) {
            throw new RuntimeException("文件不能为空");
        }
        if(offlineTranslateTempId == null) {
            throw new RuntimeException("离线翻译任务id不能为空");
        }
        // 创建保存目录
        File dir = new File(getFileDir(offlineTranslateTempId, isSource));
        if (!dir.exists()) {
            dir.mkdirs();
        }
        try {
            // 获取文件名
            String originalFilename = file.getOriginalFilename();
            if(originalFilename == null) {
                throw new RuntimeException("文件名为空");
            }
            if(originalFilename.contains("/")) {
                originalFilename = originalFilename.substring(originalFilename.lastIndexOf("/") + 1);
            }
            Path filePath = Paths.get(getFileDir(offlineTranslateTempId, isSource), originalFilename);
            // 保存文件
            Files.write(filePath, file.getBytes());
            return originalFilename;
        }catch (Exception e) {
            throw new RuntimeException("文件上传失败");
        }
    }

    private boolean checkGPUAvailable() {
        try {
            Process process = new ProcessBuilder("nvidia-smi").start();
            return process.waitFor() == 0;
        } catch (IOException | InterruptedException e) {
            return false;
        }
    }

    private String generateMD5Hash(String input) {
        try {
            MessageDigest md = MessageDigest.getInstance("MD5");
            byte[] hashBytes = md.digest(input.getBytes());
            StringBuilder sb = new StringBuilder();
            for (byte b : hashBytes) {
                sb.append(String.format("%02x", b));
            }
            return sb.toString();
        } catch (Exception e) {
            // 降级处理
            return Integer.toHexString(input.hashCode());
        }
    }

    private String getFileDir(Long offlineTranslateTempId, boolean isSource) {
        return TRANSLATION + "/" + offlineTranslateTempId + (isSource ? "/source" : "/target") + "/";
    }


    private void deleteDirectory(Path directory) {
        if (directory == null) {
            return;
        }
        try {
            if (Files.exists(directory)) {
                Files.walk(directory)
                        .sorted(Comparator.reverseOrder())
                        .map(Path::toFile)
                        .forEach(File::delete);
            }
        } catch (IOException e) {
            System.err.println("删除临时目录时出错: " + e.getMessage());
        }
    }



}
