import re, json, base64, urllib.request, time, wave, struct
DS = 'PUT_YOUR_DASHSCOPE_KEY'
SF = 'PUT_YOUR_SILICONFLOW_KEY'
def norm(s):
    s = s.lower(); s = re.sub(r"['’]", '', s); s = re.sub(r'[^a-z0-9\s]', ' ', s)
    return re.sub(r'\s+', ' ', s).strip()
def wer(ref, hyp):
    r = norm(ref).split(); hh = norm(hyp).split()
    dp = list(range(len(hh)+1))
    for i in range(1, len(r)+1):
        prev = dp[:]; dp[0] = i
        for j in range(1, len(hh)+1):
            dp[j] = min(prev[j]+1, dp[j-1]+1, prev[j-1] + (0 if r[i-1]==hh[j-1] else 1))
    return dp[len(hh)]/max(1,len(r))
def cues_of(f):
    h = open(f, encoding='utf-8', errors='ignore').read()
    d = json.loads(re.search(r'__NEXT_DATA__[^>]*>(.*?)</script>', h, re.S).group(1))
    out = []
    for para in d['props']['pageProps']['transcriptData']['translation']['paragraphs']:
        for c in para['cues']: out.append((c.get('time',0), c.get('text','')))
    return sorted(out)
def chunks(f, sec):
    w = wave.open(f); SR = w.getframerate()
    s = struct.unpack('<%dh' % (w.getnframes()), w.readframes(w.getnframes()))
    step = sec*SR; out = []; i = 0
    while i < len(s):
        seg = s[i:i+step]
        b = struct.pack('<%dh' % len(seg), *seg)
        hdr = b'RIFF'+struct.pack('<I',36+len(b))+b'WAVEfmt '+struct.pack('<IHHIIHH',16,1,1,SR,SR*2,2,16)+b'data'+struct.pack('<I',len(b))
        out.append(hdr+b); i += step
    return out
def ds(wav):
    a = 'data:audio/wav;base64,' + base64.b64encode(wav).decode()
    body = {"model":"qwen3-asr-flash","input":{"messages":[{"role":"user","content":[{"audio":a}]}]},"parameters":{"asr_options":{"language":"en","enable_itn":False}}}
    r = urllib.request.Request('https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation', data=json.dumps(body).encode(), headers={'Authorization':'Bearer '+DS,'Content-Type':'application/json'})
    try:
        with urllib.request.urlopen(r, timeout=90) as x: return json.loads(x.read().decode())['output']['choices'][0]['message']['content'][0]['text']
    except Exception: return ''
def sf(wav):
    bd='----x'; p=b''
    p += ('--%s\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\n'%bd).encode()+wav+b'\r\n'
    for k,v in [('model','Qwen/Qwen3-ASR-1.7B'),('language','en'),('response_format','json')]:
        p += ('--%s\r\nContent-Disposition: form-data; name="%s"\r\n\r\n%s\r\n'%(bd,k,v)).encode()
    p += ('--%s--\r\n'%bd).encode()
    r = urllib.request.Request('https://api.siliconflow.cn/v1/audio/transcriptions', data=p, headers={'Authorization':'Bearer '+SF,'Content-Type':'multipart/form-data; boundary='+bd})
    try:
        with urllib.request.urlopen(r, timeout=90) as x: return json.loads(x.read().decode()).get('text','')
    except Exception: return ''
talks = [('adichie','尼日利亚口音'), ('mitra','印度口音'), ('sirolli','意大利口音')]
print('%-14s %-10s %-10s' % ('讲者', '阿里 WER', '硅基 WER'))
for tag, label in talks:
    cs = chunks('/tmp/%s.wav' % tag, 12)
    ref = ' '.join(t for tm,t in cues_of('/tmp/%s.html' % tag) if tm/1000.0 < 120)
    out = {}
    for name, fn in [('ds', ds), ('sf', sf)]:
        txt = ' '.join(filter(None, (fn(c) for c in cs)))
        out[name] = wer(ref, txt)*100
    print('%-14s %-10s %-10s' % (label, '%.1f%%' % out['ds'], '%.1f%%' % out['sf']))
