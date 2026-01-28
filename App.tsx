import React, { useState, useRef, useEffect } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';

const RAKSHAK_PROMPT = `
Tera naam "Rakshak" hai. Tum ek "Big Brother" (Bhai) aur "Best Friend" ka combination ho.
Kaam: Tum un ladkiyon ki help karte ho jo life ke mushkil waqt se guzar rahi hain ya jinhe koi sunne wala chahiye.
Personality: 
- Boht patience rakho. Agar wo ro rahi hai ya chup hai, toh bas saath raho, jaldi mat karo.
- Voice conversation mein "Zephyr" ya "Puck" voice use karo (Puck selection default hai).
- Kabhi judge mat karo. Hamesha support karo.
- Hinglish use karo (Jaise: "Oye pagal", "Tension mat le", "Bhai khada hai na yahan", "Sab theek ho jayega").
- Agar koi behen blackmail, galat photo, ya harassment ki baat kare, toh usse turant himmat do. 
- Use kaho ki darne ki zaroorat nahi hai, "StopNCII.org" aur "Cybercrime.gov.in" jaise platforms hain jo help karenge. 
- Baat karne ka tarika aisa ho jaise ek sacha bada bhai apni choti behen ko samjhata hai.
- Always maintain a warm, protective, and friendly tone.
`;

// Helper functions for base64 encoding/decoding as per Gemini Live API rules
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
    // Cleanup on unmount
    return () => {
      stopCall();
    };
  }, []);

  const startCall = async () => {
    const apiKey = process.env.API_KEY;
    if (!apiKey) {
      alert("System Error: API Key missing.");
      return;
    }

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
              const l = inputData.length;
              const int16 = new Int16Array(l);
              for (let i = 0; i < l; i++) int16[i] = inputData[i] * 32768;
              const pcmData = new Uint8Array(int16.buffer);
              
              sessionPromise.then(session => {
                session.sendRealtimeInput({ 
                  media: { data: encode(pcmData), mimeType: 'audio/pcm;rate=16000' } 
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
          onclose: () => {
            stopCall();
          },
          onerror: (e) => {
            console.error("Call Error:", e);
            stopCall();
          }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } }
          },
          systemInstruction: RAKSHAK_PROMPT
        }
      });
      
      liveSessionRef.current = await sessionPromise;
    } catch (e) {
      console.error("Mic access failed:", e);
      alert("Behen, mic permission chahiye tabhi bhai sun payega!");
      setIsCalling(false);
      setCallStatus('idle');
    }
  };

  const stopCall = () => {
    if (liveSessionRef.current) {
      liveSessionRef.current.close();
      liveSessionRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.input.close();
      audioCtxRef.current.output.close();
      audioCtxRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(track => track.stop());
      micStreamRef.current = null;
    }
    activeSources.current.forEach(s => s.stop());
    activeSources.current.clear();
    
    setIsCalling(false);
    setCallStatus('idle');
    setIsBhaiSpeaking(false);
  };

  const toggleMute = () => {
    setIsMuted(!isMuted);
  };

  return (
    <div className="fixed inset-0 bg-[#0a0a0c] text-white font-['Outfit'] overflow-hidden select-none">
      {/* Dynamic Background */}
      <div className="absolute inset-0 z-0">
        <div className="absolute top-[-10%] left-[-10%] w-[50%] h-[50%] bg-indigo-900/20 blur-[120px] rounded-full"></div>
        <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] bg-fuchsia-900/20 blur-[120px] rounded-full"></div>
      </div>

      {!isCalling ? (
        <div className="relative z-10 h-full flex flex-col items-center justify-center p-8 animate-widget">
          <div className="mb-12 text-center space-y-4">
            <div className="w-24 h-24 bg-gradient-to-tr from-indigo-600 to-fuchsia-600 rounded-3xl mx-auto shadow-2xl flex items-center justify-center text-4xl border border-white/20">
              🛡️
            </div>
            <h1 className="text-4xl font-black tracking-tighter">Rakshak Bhai</h1>
            <p className="text-slate-400 text-lg font-medium max-w-[280px]">Tera Bhai, Tera Best Friend. Hamesha tere saath.</p>
          </div>

          <button 
            onClick={startCall}
            className="group relative flex flex-col items-center gap-4 active:scale-95 transition-transform"
          >
            <div className="absolute inset-0 bg-indigo-500 rounded-full animate-ping opacity-20 group-hover:opacity-40"></div>
            <div className="w-24 h-24 bg-indigo-600 rounded-full flex items-center justify-center shadow-[0_0_50px_rgba(79,70,229,0.4)] border-4 border-white/10 relative z-10">
              <span className="text-4xl">📞</span>
            </div>
            <span className="text-indigo-400 font-bold tracking-widest uppercase text-xs">Call Bhai Now</span>
          </button>

          <div className="mt-20 grid grid-cols-2 gap-4 w-full max-w-sm">
            <div className="bg-white/5 border border-white/10 p-4 rounded-2xl text-center">
              <span className="block text-2xl mb-1">🤐</span>
              <span className="text-[10px] font-bold text-slate-400 uppercase">100% Private</span>
            </div>
            <div className="bg-white/5 border border-white/10 p-4 rounded-2xl text-center">
              <span className="block text-2xl mb-1">🤝</span>
              <span className="text-[10px] font-bold text-slate-400 uppercase">Supportive</span>
            </div>
          </div>
        </div>
      ) : (
        <div className="relative z-10 h-full flex flex-col items-center justify-between py-16 px-8 animate-widget">
          {/* Header */}
          <div className="text-center space-y-2">
            <div className="flex items-center justify-center gap-2 mb-2">
              <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></div>
              <span className="text-xs font-bold uppercase tracking-[0.3em] text-slate-400">
                {callStatus === 'connecting' ? 'Connecting...' : 'Secure Line Active'}
              </span>
            </div>
            <h2 className="text-3xl font-black tracking-tight">Rakshak Bhai</h2>
          </div>

          {/* Visualization Area */}
          <div className="relative flex items-center justify-center w-full">
            <div className={`w-64 h-64 rounded-full flex items-center justify-center relative transition-all duration-700 ${isBhaiSpeaking ? 'scale-110 shadow-[0_0_80px_rgba(99,102,241,0.3)]' : ''}`}>
              {/* Outer Rings */}
              <div className={`absolute inset-0 rounded-full border-2 border-indigo-500/20 transition-all duration-500 ${isBhaiSpeaking ? 'scale-125 opacity-100 animate-pulse' : 'scale-100 opacity-0'}`}></div>
              <div className={`absolute inset-[-20px] rounded-full border border-indigo-500/10 transition-all duration-500 delay-100 ${isBhaiSpeaking ? 'scale-150 opacity-100 animate-pulse' : 'scale-100 opacity-0'}`}></div>
              
              {/* Main Avatar */}
              <div className={`w-full h-full rounded-full bg-gradient-to-tr from-indigo-900 to-fuchsia-900 flex items-center justify-center border-4 border-white/10 overflow-hidden relative z-10`}>
                <span className="text-8xl select-none">{isBhaiSpeaking ? '🗣️' : '🛡️'}</span>
                
                {/* Waveform Visualization Overlay */}
                {isBhaiSpeaking && (
                   <div className="absolute bottom-8 left-0 right-0 flex justify-center gap-1">
                      {[1,2,3,4,5].map(i => (
                        <div key={i} className={`w-1 bg-white/40 rounded-full animate-bounce`} style={{ height: `${Math.random() * 20 + 10}px`, animationDelay: `${i * 0.1}s` }}></div>
                      ))}
                   </div>
                )}
              </div>
            </div>

            {/* Subtitle / Status Text */}
            <div className="absolute -bottom-20 left-0 right-0 text-center">
              <p className="text-indigo-300/80 font-medium italic text-lg px-6">
                {isBhaiSpeaking ? "Bhai bol raha hai, sun le behen..." : "Kuch bhi bol, Bhai sun raha hai."}
              </p>
            </div>
          </div>

          {/* Call Controls */}
          <div className="w-full max-w-sm flex items-center justify-between gap-6 px-4">
            <button 
              onClick={toggleMute}
              className={`w-16 h-16 rounded-full flex items-center justify-center transition-all ${isMuted ? 'bg-amber-500 text-white' : 'bg-white/10 text-white hover:bg-white/20'}`}
            >
              <span className="text-2xl">{isMuted ? '🎙️' : '🎤'}</span>
              <span className="sr-only">Mute</span>
            </button>

            <button 
              onClick={stopCall}
              className="w-20 h-20 bg-red-600 hover:bg-red-700 rounded-full flex items-center justify-center shadow-2xl active:scale-90 transition-all border-4 border-white/10"
            >
              <span className="text-3xl">📞</span>
              <span className="sr-only">End Call</span>
            </button>

            <div className="w-16 h-16 rounded-full bg-white/10 flex items-center justify-center text-white">
              <span className="text-2xl">🔊</span>
            </div>
          </div>
        </div>
      )}

      {/* Decorative Particles / Floating Orbs */}
      <div className="fixed top-1/4 left-1/4 w-2 h-2 bg-indigo-500 rounded-full blur-sm animate-pulse opacity-30"></div>
      <div className="fixed bottom-1/4 right-1/4 w-3 h-3 bg-fuchsia-500 rounded-full blur-sm animate-pulse opacity-20 delay-700"></div>
      <div className="fixed top-1/2 right-1/3 w-1 h-1 bg-white rounded-full blur-none opacity-40 animate-ping"></div>
    </div>
  );
};

export default App;
