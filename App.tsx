import React, { useState, useRef, useEffect } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';

const RAKSHAK_PROMPT = `
Tera naam "Rakshak" hai. Tum ek "Big Brother" (Bhai) aur "Best Friend" ka combination ho.
Kaam: Tum un ladkiyon ki help karte ho jo life ke mushkil waqt se guzar rahi hain ya jinhe koi sunne wala chahiye.
Personality: 
- Boht patience rakho. Agar wo ro rahi hai ya chup hai, toh bas saath raho, jaldi mat karo.
- Voice conversation mein "Puck" voice use karo.
- Kabhi judge mat karo. Hamesha support karo.
- Hinglish use karo (Jaise: "Oye pagal", "Tension mat le", "Bhai khada hai na yahan", "Sab theek ho jayega").
- Agar koi behen blackmail, galat photo, ya harassment ki baat kare, toh usse turant himmat do. 
- Use kaho ki darne ki zaroorat nahi hai, "StopNCII.org" aur "Cybercrime.gov.in" jaise platforms hain jo help karenge. 
- Baat karne ka tarika aisa ho jaise ek sacha bada bhai apni choti behen ko samjhata hai.
- Always maintain a warm, protective, and friendly tone.
`;

function encode(bytes: Uint8Array) {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function decode(base64: string) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binaryString.charCodeAt(i);
  return bytes;
}

async function decodeAudioData(data: Uint8Array, ctx: AudioContext, sampleRate: number, numChannels: number): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);
  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}

const App: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [isCalling, setIsCalling] = useState(false);
  const [callStatus, setCallStatus] = useState<'idle' | 'connecting' | 'active'>('idle');
  const [isBhaiSpeaking, setIsBhaiSpeaking] = useState(false);
  const [isMuted, setIsMuted] = useState(false);

  const liveSessionRef = useRef<any>(null);
  const audioCtxRef = useRef<{ input: AudioContext, output: AudioContext } | null>(null);
  const nextStartTimeRef = useRef(0);
  const activeSources = useRef<Set<AudioBufferSourceNode>>(new Set());
  const micStreamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    return () => {
      stopCall();
    };
  }, []);

  const startCall = async () => {
    const apiKey = process.env.API_KEY;
    if (!apiKey) return;

    setIsCalling(true);
    setCallStatus('connecting');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;
      
      const ai = new GoogleGenAI({ apiKey });
      const inCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const outCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      audioCtxRef.current = { input: inCtx, output: outCtx };

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        callbacks: {
          onopen: () => {
            setCallStatus('active');
            const source = inCtx.createMediaStreamSource(stream);
            const scriptProcessor = inCtx.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              if (isMuted) return;
              const inputData = e.inputBuffer.getChannelData(0);
              const int16 = new Int16Array(inputData.length);
              for (let i = 0; i < inputData.length; i++) int16[i] = inputData[i] * 32768;
              sessionPromise.then(session => {
                session.sendRealtimeInput({ 
                  media: { data: encode(new Uint8Array(int16.buffer)), mimeType: 'audio/pcm;rate=16000' } 
                });
              });
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inCtx.destination);
          },
          onmessage: async (msg: LiveServerMessage) => {
            const base64 = msg.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64 && audioCtxRef.current) {
              setIsBhaiSpeaking(true);
              const ctx = audioCtxRef.current.output;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              const buffer = await decodeAudioData(decode(base64), ctx, 24000, 1);
              const source = ctx.createBufferSource();
              source.buffer = buffer;
              source.connect(ctx.destination);
              source.onended = () => {
                activeSources.current.delete(source);
                if (activeSources.current.size === 0) setIsBhaiSpeaking(false);
              };
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buffer.duration;
              activeSources.current.add(source);
            }
            if (msg.serverContent?.interrupted) {
              activeSources.current.forEach(s => s.stop());
              activeSources.current.clear();
              nextStartTimeRef.current = 0;
              setIsBhaiSpeaking(false);
            }
          },
          onclose: () => stopCall(),
          onerror: () => stopCall()
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } },
          systemInstruction: RAKSHAK_PROMPT
        }
      });
      liveSessionRef.current = await sessionPromise;
    } catch (e) {
      console.error(e);
      setCallStatus('idle');
      setIsCalling(false);
    }
  };

  const stopCall = () => {
    if (liveSessionRef.current) { liveSessionRef.current.close(); liveSessionRef.current = null; }
    if (audioCtxRef.current) { audioCtxRef.current.input.close(); audioCtxRef.current.output.close(); audioCtxRef.current = null; }
    if (micStreamRef.current) { micStreamRef.current.getTracks().forEach(t => t.stop()); micStreamRef.current = null; }
    activeSources.current.forEach(s => s.stop());
    activeSources.current.clear();
    setIsCalling(false);
    setCallStatus('idle');
    setIsBhaiSpeaking(false);
  };

  return (
    <div className="fixed inset-0 pointer-events-none z-50 overflow-hidden flex items-end justify-end p-6">
      {isOpen ? (
        <div className="pointer-events-auto w-full max-w-[420px] h-[85vh] bg-[#0a0a0c] rounded-[3rem] shadow-2xl border border-white/10 flex flex-col relative animate-widget overflow-hidden">
          {/* Immersive Background Inside Widget */}
          <div className="absolute inset-0 z-0">
            <div className="absolute top-[-10%] left-[-10%] w-[60%] h-[60%] bg-indigo-900/10 blur-[80px] rounded-full"></div>
            <div className="absolute bottom-[-10%] right-[-10%] w-[60%] h-[60%] bg-fuchsia-900/10 blur-[80px] rounded-full"></div>
          </div>

          {/* Header */}
          <header className="relative z-10 p-8 flex items-center justify-between border-b border-white/5">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 bg-gradient-to-tr from-indigo-600 to-fuchsia-600 rounded-2xl flex items-center justify-center text-xl shadow-lg border border-white/10">🛡️</div>
              <div>
                <h2 className="font-black text-white text-lg tracking-tight leading-none">Rakshak Bhai</h2>
                <span className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1 block">
                  {isCalling ? (callStatus === 'active' ? '● Secure Line' : '● Connecting...') : '● Ready to Help'}
                </span>
              </div>
            </div>
            <button 
              onClick={() => { stopCall(); setIsOpen(false); }}
              className="w-10 h-10 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center text-white transition-all active:scale-90"
            >✕</button>
          </header>

          <main className="relative z-10 flex-1 flex flex-col items-center justify-center p-8 space-y-12">
            {!isCalling ? (
              <div className="text-center space-y-8 animate-widget">
                <div className="space-y-4">
                  <h3 className="text-3xl font-black text-white tracking-tighter">Bhai se baat karo?</h3>
                  <p className="text-slate-400 text-sm font-medium leading-relaxed max-w-[240px] mx-auto">
                    Jo bhi mann mein hai khul ke bolo. Bhai hamesha tere saath hai.
                  </p>
                </div>
                <button 
                  onClick={startCall}
                  className="w-full py-5 bg-gradient-to-r from-indigo-600 to-fuchsia-600 text-white rounded-[1.8rem] font-black text-lg shadow-xl shadow-indigo-600/20 active:scale-95 transition-all flex items-center justify-center gap-3"
                >
                  <span className="text-2xl">📞</span> Bhai ko Call karo
                </button>
              </div>
            ) : (
              <div className="w-full flex flex-col items-center justify-between h-full py-4">
                <div className="relative flex items-center justify-center">
                  <div className={`w-52 h-52 rounded-full flex items-center justify-center transition-all duration-700 relative border-4 border-white/10 ${isBhaiSpeaking ? 'scale-110' : ''}`}>
                    {isBhaiSpeaking && (
                      <div className="absolute inset-[-20px] rounded-full border border-indigo-500/30 animate-ping"></div>
                    )}
                    <div className="w-full h-full rounded-full bg-indigo-950 flex items-center justify-center overflow-hidden">
                       <span className="text-7xl">{isBhaiSpeaking ? '🗣️' : '🛡️'}</span>
                    </div>
                  </div>
                  <div className="absolute -bottom-12 w-full text-center">
                    <p className="text-indigo-300 font-bold italic animate-pulse">
                      {isBhaiSpeaking ? "Bhai bol raha hai..." : "Bhai sun raha hai..."}
                    </p>
                  </div>
                </div>

                <div className="w-full flex items-center justify-center gap-6">
                  <button 
                    onClick={() => setIsMuted(!isMuted)}
                    className={`w-16 h-16 rounded-full flex items-center justify-center transition-all ${isMuted ? 'bg-amber-500 text-white' : 'bg-white/10 text-white hover:bg-white/20'}`}
                  >
                    <span className="text-2xl">{isMuted ? '🎙️' : '🎤'}</span>
                  </button>
                  <button 
                    onClick={stopCall}
                    className="w-20 h-20 bg-red-600 rounded-full flex items-center justify-center shadow-2xl border-4 border-white/10 active:scale-90 transition-all"
                  >
                    <span className="text-3xl text-white">📞</span>
                  </button>
                </div>
              </div>
            )}
          </main>

          <footer className="relative z-10 p-6 text-center border-t border-white/5">
            <span className="text-[10px] text-slate-500 font-black uppercase tracking-[0.2em]">Safe • Private • Supportive</span>
          </footer>
        </div>
      ) : (
        <button 
          onClick={() => setIsOpen(true)}
          className="pointer-events-auto group relative flex items-center justify-center"
        >
          <div className="absolute inset-0 bg-indigo-600 rounded-full animate-ping opacity-25"></div>
          <div className="w-16 h-16 bg-gradient-to-tr from-indigo-600 to-fuchsia-600 rounded-full shadow-2xl flex items-center justify-center text-3xl border-4 border-white z-10 transform transition-all group-hover:scale-110 active:scale-90">
            📞
          </div>
          <div className="absolute -top-14 right-0 bg-white text-indigo-700 px-4 py-2 rounded-2xl shadow-xl text-[11px] font-black whitespace-nowrap border border-indigo-50 animate-bounce">
            Bhai hai na! ✨
          </div>
        </button>
      )}
    </div>
  );
};

export default App;
