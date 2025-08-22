package com.read.duolingo.entity;

import com.read.duolingo.enums.LanguageType;
import lombok.Getter;
import lombok.Setter;


/**
 * 书籍实体类
 * 表示书籍的基本信息，包含标题、作者、分类等核心属性
 */
@Setter
@Getter
public class OfflineTranslateTemp {

    /**
     * 书籍ID
     */
    private Long id;

    /**
     * 书籍翻译状态
     */
    private Integer translationStatus;

    private Integer failCount;

    private String fileName;

    private Integer progress;

    /**
     * 书籍翻译目标语言
     * @see LanguageType
     */
    private String langCode;

}
