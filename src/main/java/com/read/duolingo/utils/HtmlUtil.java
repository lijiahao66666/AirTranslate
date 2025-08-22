package com.read.duolingo.utils;

import org.jsoup.Jsoup;
import org.jsoup.nodes.*;
import org.jsoup.parser.Parser;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BiFunction;
import java.util.regex.Pattern;

public class HtmlUtil {

    private static final String TRANSLATION_ATTR = "data-translation"; // 统一的属性名
    private static final String ORIGINAL_VALUE = "original"; // 原文标签的值
    private static final String TRANSLATED_VALUE = "translated"; // 翻译标签的值
    private static final Pattern CHINESE_PATTERN = Pattern.compile("[\\u4e00-\\u9fa5]");
    private static final Pattern SKIP_TAGS = Pattern.compile("(script|style|code|pre)", Pattern.CASE_INSENSITIVE);


    // 定义要添加的CSS样式
    private static final String TRANSLATION_CSS =
        """
            <style type="text/css">
              /* 翻译样式 */
              .translation-container { display: block; }
              .original-text { display: block; }
              .translated-text {
                display: block;
                margin-top: 4px;
                color: #666;
                font-size: 1.0em;
              }
            </style>
        """;

    public static void processHtmlFiles(Path rootDir, BiFunction<Integer, List<String>, List<String>> function) throws IOException {
        // 统计需要翻译的html文本数量
        int count = countNeedTranslateHtml(rootDir);
        AtomicInteger current = new AtomicInteger(0);
        Files.walk(rootDir)
                .filter(path -> path.toString().toLowerCase().endsWith(".html") ||
                        path.toString().toLowerCase().endsWith(".xhtml"))
                .forEach(path -> {
                    try {
                        String content = Files.readString(path, StandardCharsets.UTF_8);
                        String processedContent = processHtmlFile(content, (current.get()*100)/count, function);
                        // 保存修改后的文件
                        Files.writeString(path, processedContent, StandardCharsets.UTF_8);
                        current.addAndGet(1);
                    } catch (Exception e) {
                        throw new RuntimeException("处理 HTML 文件时出错: " + path + " - " + e.getMessage());
                    }
                });
    }


    /**
     * 计算当前文件有多少个需要翻译的html文本
     * @return
     * @throws IOException
     */
    private static int countNeedTranslateHtml(Path rootDir) {
        // 统计需要翻译的html文本数量
        AtomicInteger count = new AtomicInteger();
        try {
            Files.walk(rootDir)
                    .filter(path -> path.toString().toLowerCase().endsWith(".html") ||
                            path.toString().toLowerCase().endsWith(".xhtml"))
                    .forEach(path -> {
                        count.addAndGet(1);
                    });
        } catch (IOException e) {
            throw new RuntimeException("遍历目录时出错: " + rootDir + " - " + e.getMessage());
        }
        return count.get();
    }

    public static String processHtmlFile(String htmlContent, int progress, BiFunction<Integer, List<String>, List<String>> function) throws IOException {
        // 提取原始XML声明
        String xmlDeclaration = "";
        if (htmlContent.startsWith("<?xml")) {
            int endIndex = htmlContent.indexOf("?>") + 2;
            xmlDeclaration = htmlContent.substring(0, endIndex);
        }

        // 提取原始DOCTYPE
        String originalDoctype = "";
        int doctypeStart = htmlContent.indexOf("<!DOCTYPE");
        if (doctypeStart != -1) {
            int doctypeEnd = htmlContent.indexOf(">", doctypeStart) + 1;
            originalDoctype = htmlContent.substring(doctypeStart, doctypeEnd);
        }

        // 检测文档类型
        boolean isXhtml = !xmlDeclaration.isEmpty() ||
                !originalDoctype.isEmpty() ||
                htmlContent.contains("xmlns=");

        // 根据文档类型选择解析器
        Document doc;
        if (isXhtml) {
            // 移除原始声明防止重复
            String contentToParse = htmlContent
                    .replace(xmlDeclaration, "")
                    .replace(originalDoctype, "");

            doc = Jsoup.parse(contentToParse, "", Parser.xmlParser());
            doc.outputSettings()
                    .syntax(Document.OutputSettings.Syntax.xml)
                    .escapeMode(Entities.EscapeMode.xhtml)
                    .prettyPrint(false);
        } else {
            doc = Jsoup.parse(htmlContent);
            doc.outputSettings()
                    .syntax(Document.OutputSettings.Syntax.html)
                    .escapeMode(Entities.EscapeMode.base)
                    .prettyPrint(false);
        }

        doc.outputSettings().charset(StandardCharsets.UTF_8);

        // 添加翻译CSS和JS到<head>
        addTranslationStyles(doc);

        // 处理正文内容
        Element body = doc.body();
        processBody(body, progress, function);

        // 获取处理后的HTML
        String processedHtml = doc.outerHtml();

        // 为XHTML手动添加原始声明
        if (isXhtml) {
            StringBuilder result = new StringBuilder();
            if (!xmlDeclaration.isEmpty()) {
                result.append(xmlDeclaration).append("\n");
            }
            if (!originalDoctype.isEmpty()) {
                result.append(originalDoctype).append("\n");
            }
            result.append(processedHtml);
            return result.toString();
        }

        return processedHtml;
    }

    private static void addTranslationStyles(Document doc) {
        // 检查是否已添加过样式
        Element existingStyle = doc.select("style:contains(translation-container)").first();
        if (existingStyle == null) {
            // 添加CSS和JS
            Element head = doc.head();
            head.append(TRANSLATION_CSS);

            // 设置默认body类
            Element body = doc.body();
            if (!body.hasClass("show-both") && !body.hasClass("show-original") && !body.hasClass("show-translation")) {
                body.addClass("show-both");
            }
        }
    }

    private static void processBody(Element body, int progress, BiFunction<Integer, List<String>, List<String>> function) {
        List<TextNode> textNodes = new ArrayList<>();
        collectTextNodes(body, textNodes);
        batchProcessTextNodes(textNodes, progress, function);
    }

    private static boolean isProcessed(Node node) {
        if (node instanceof Element element) {
            return element.hasClass("translation-container") ||
                    element.parents().stream().anyMatch(e -> e.hasClass("translation-container"));
        }
        return false;
    }

    private static void collectTextNodes(Element element, List<TextNode> textNodes) {
        if (shouldSkipElement(element) || isProcessed(element)) {
            return;
        }

        for (Node node : element.childNodes()) {
            if (node instanceof Element childElement) {
                collectTextNodes(childElement, textNodes);
            } else if (node instanceof TextNode textNode) {
                // 检查文本节点是否已被包裹在翻译容器中
                if (isProcessed(textNode)) continue;

                String text = textNode.getWholeText().trim();
                if (!text.isEmpty() && containsChinese(text)) {
                    textNodes.add(textNode);
                }
            }
        }
    }

    private static void batchProcessTextNodes(List<TextNode> textNodes, int progress, BiFunction<Integer, List<String>, List<String>> function) {
        // 过滤掉已被处理的节点
        List<TextNode> validBatch = textNodes.stream()
                .filter(node -> !isProcessed(node))
                .toList();

        if (validBatch.isEmpty()) return;

        // 准备批量文本 - 添加序号前缀
        List<String> originalTexts = validBatch.stream().map(TextNode::getWholeText).toList();

        // 执行批量翻译
        List<String> translations = function.apply(progress, originalTexts);

        // 替换节点
        for (int i = 0; i < validBatch.size(); i++) {
            String translation = translations.get(i);
            TextNode node = validBatch.get(i);
            if (translation != null && !translation.isEmpty()) {
                replaceTextNode(node, translation);
            }
        }

    }



    private static void replaceTextNode(TextNode textNode, String translatedText) {
        // 确保节点尚未被处理
        if (isProcessed(textNode)) {
            return;
        }

        String originalText = textNode.getWholeText().trim();

        Element container = new Element("div").addClass("translation-container");
        container.appendChild(new Element("span")
                .attr(TRANSLATION_ATTR, ORIGINAL_VALUE)
                .addClass("original-text")
                .text(originalText));
        container.appendChild(new Element("div")
                .attr(TRANSLATION_ATTR, TRANSLATED_VALUE)
                .addClass("translated-text")
                .text(translatedText));

        textNode.replaceWith(container);
    }


    private static boolean shouldSkipElement(Element element) {
        // 跳过特殊标签和已处理的翻译容器
        return SKIP_TAGS.matcher(element.tagName()).matches() ||
                element.hasClass("translation-container") ||
                element.parents().stream().anyMatch(e -> e.hasClass("translation-container"));
    }

    private static boolean containsChinese(String text) {
        return text != null && CHINESE_PATTERN.matcher(text).find();
    }

}
