# Ubuntu 20.04 安装 Tesseract

## 1. 安装 Tesseract

```bash
sudo apt update
sudo apt install tesseract-ocr -y
```

## 2. 安装中文语言包


```bash
# 简体中文
sudo apt install tesseract-ocr-chi-sim -y

# 繁体中文（可选）
sudo apt install tesseract-ocr-chi-tra -y
```

## 3. 验证安装


```bash
# 查看版本
tesseract --version

# 查看已安装的语言包
tesseract --list-langs
```

## 4. 基本使用

```bash
# 识别英文（默认）
tesseract image.png output

# 识别中文
tesseract image.png output -l chi_sim

# 中英文混合
tesseract image.png output -l chi_sim+eng

# 直接输出到终端（不生成文件）
tesseract image.png stdout -l chi_sim
```


