package com.lijiahao.read.web.controller;

import com.lijiahao.read.service.TranslateService;
import com.lijiahao.read.web.dto.Response;
import jakarta.annotation.Resource;
import jakarta.servlet.http.HttpServletResponse;
import lombok.extern.slf4j.Slf4j;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.util.List;

@Slf4j
@RestController
@RequestMapping("/translate")
public class TranslateController {

    @Resource
    private TranslateService translateService;

    /**
     * 离线翻译提交
     * @param translationTargetType 翻译目标类型
     * @param file 书籍文件
     */
    @CrossOrigin
    @RequestMapping("/offline/submit")
    public Response<Long> submitOfflineTranslate(@RequestParam("translationTargetType") Integer translationTargetType,
                                                 @RequestParam("file") MultipartFile file) {
        try {
            return Response.success(translateService.submitOfflineTranslate(translationTargetType, file));
        }catch (Exception e){
            log.error("submit offline translate error", e);
            return Response.fail(500, "系统错误");
        }
    }
    /**
     * 查询离线翻译书籍进度，0-100
     */
    @CrossOrigin
    @RequestMapping("/offline/query")
    public Response<Integer> queryOfflineTranslateResult(@RequestParam Long offlineTranslateTempId) {
        try {
            return Response.success(translateService.queryOfflineTranslateResult(offlineTranslateTempId));
        } catch (Exception e) {
            log.error("query offline translate result error", e);
            return Response.fail(500, "query offline translate result error");
        }
    }

    /**
     * 在线翻译
     */
    @CrossOrigin
    @RequestMapping("/online/invoke")
    public Response<String> invokeOnlineTranslate(@RequestParam("source") String source,
                                                @RequestParam("translationTargetType") Integer translationTargetType) {
        try {
            return Response.success(translateService.llmTranslateSource(List.of(source), translationTargetType, true).getFirst());
        }catch (Exception e){
            log.error("online translate submit error", e);
            return Response.fail(500, "系统错误");
        }
    }

    /**
     * 下载翻译后的文件
     * @param offlineTranslateTempId 离线翻译任务id
     * @param response HTTP响应对象
     */
    @CrossOrigin
    @GetMapping("/download")
    public void download(@RequestParam Long offlineTranslateTempId, HttpServletResponse response) {
        try {
            // 获取文件绝对路径
            String filePath = translateService.getDownloadPath(offlineTranslateTempId);
            File file = new File(filePath);

            // 设置响应头（告知浏览器这是一个需要下载的文件）
            // epub标准MIME类型
            response.setContentType("application/epub+zip");
            response.setHeader("Content-Disposition", "attachment; filename=" + file.getName());

            // 将文件内容写入响应流
            Files.copy(file.toPath(), response.getOutputStream());
        } catch (Exception e) {
            log.error("文件下载失败, offlineTranslateTempId={}", offlineTranslateTempId, e);
            response.setStatus(500);
            try {
                response.getWriter().write("下载失败: " + e.getMessage());
            } catch (IOException ex) {
                log.error("写入错误信息失败", ex);
            }
        }
    }
}
