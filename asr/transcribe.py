# -*- coding: utf-8 -*-
"""本地整段转写: faster-whisper 离线识别, 用来给没有时间轴的歌词补时间戳

调用: python transcribe.py --model base --file <音频路径>
stdout 输出一行 JSON:
  {"type":"result","ok":true,"language":"zh","duration":213.4,
   "text":"...","segments":[{"start":1.2,"end":3.4,"text":"..."}],"words":[...]}
"""
import argparse
import json
import os
import sys
import traceback

os.environ.setdefault('HF_ENDPOINT', 'https://hf-mirror.com')

# 本机 torch 的 c10.dll 初始化失败, ctranslate2 只是可选依赖 torch,
# 这里屏蔽掉让它走 ImportError 分支, 避免整个 faster-whisper 导入失败
sys.modules.setdefault('torch', None)


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def log(msg):
    sys.stderr.write(str(msg) + '\n')
    sys.stderr.flush()


HALLUCINATION = ('谢谢观看', '字幕', '请订阅', '感谢观看', '谢谢大家', '字幕组', '未经授权', '明镜与点点')


def clean_text(t):
    t = (t or '').strip()
    if not t:
        return ''
    for bad in HALLUCINATION:
        if bad in t and len(t) <= 16:
            return ''
    try:
        import zhconv
        t = zhconv.convert(t, 'zh-cn')
    except Exception:
        pass
    return t


def run_file(model, path, language):
    # 本机 onnxruntime 的 VAD 会崩溃, 统一关闭; 静音由调用方按峰值过滤
    segs, info = model.transcribe(
        path, language=language, beam_size=5, vad_filter=False,
        word_timestamps=True, condition_on_previous_text=False,
        initial_prompt='以下是中文歌词。')
    out = []
    words = []
    text_parts = []
    for s in segs:
        text_parts.append(s.text.strip())
        out.append({'start': round(s.start, 2), 'end': round(s.end, 2), 'text': s.text.strip()})
        for w in (s.words or []):
            words.append({'start': round(w.start, 2), 'end': round(w.end, 2), 'word': w.word})
    emit({'type': 'result', 'ok': True, 'language': info.language,
          'duration': round(info.duration, 2), 'text': clean_text(''.join(text_parts)),
          'segments': out, 'words': words})
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', default='base')
    ap.add_argument('--device', default='cpu')
    ap.add_argument('--compute', default='float32')
    ap.add_argument('--language', default='zh')
    ap.add_argument('--file', default='')
    args = ap.parse_args()

    if not args.file:
        emit({'type': 'error', 'message': '需要 --file 指定要转写的音频'})
        return 1
    try:
        from faster_whisper import WhisperModel
        base = os.path.dirname(os.path.abspath(__file__))
        local = os.path.join(base, 'models', 'faster-whisper-' + args.model)
        name = local if os.path.isdir(local) else args.model
        # 本机 CPU 不支持 AVX2, int8 量化反而更慢, 默认用 float32
        model = WhisperModel(name, device=args.device, compute_type=args.compute,
                             download_root=os.path.join(base, 'models'))
        return run_file(model, args.file, args.language)
    except KeyboardInterrupt:
        return 0
    except Exception as e:
        emit({'type': 'error', 'message': str(e)})
        log(traceback.format_exc())
        return 1


if __name__ == '__main__':
    sys.exit(main())
