
import React, { useState, useRef, useEffect, useCallback } from 'react';
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
`;

// --- HELPER FUNCTIONS ---
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
    for (let i = 0; i < frameCount; i++) channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
  }
  return buffer;
}

const App: React.FC = () => {
  // --- STATE FOR SAFETY APP ---
  const [isScreamGuardActive, setIsScreamGuardActive] = useState(false);
  const [emergencyActive, setEmergencyActive] = useState(false);
  const [strobeActive, setStrobeActive] = useState(false);
  const [stealthActive, setStealthActive] = useState(false);
  const [tapCount, setTapCount] = useState(0);

  // --- STATE FOR RAKSHAK WIDGET ---
  const [isRakshakOpen, setIsRakshakOpen] = useState(false);
  const [isCalling, setIsCalling] = useState(false);
  const [isBhaiSpeaking, setIsBhaiSpeaking] = useState(false);
  const [isMuted, setIsMuted] = useState(false);

  // --- REFS ---
  const liveSessionRef = useRef<any>(null);
  const audioCtxRef = useRef<{ input: AudioContext, output: AudioContext } | null>(null);
  const nextStartTimeRef = useRef(0);
  const activeSources = useRef<Set<AudioBufferSourceNode>>(new Set());
  const micStreamRef = useRef<MediaStream | null>(null);
  const guardAudioCtxRef = useRef<AudioContext | null>(null);

  // --- SAFETY LOGIC: SCREAM GUARD ---
  useEffect(() => {
    let animationFrame: number;
    const startScreamGuard = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
        guardAudioCtxRef.current = ctx;
        const analyser = ctx.createAnalyser();
        const mic = ctx.createMediaStreamSource(stream);
        mic.connect(analyser);
        
        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        const checkVolume = () => {
          analyser.getByteFrequencyData(dataArray);
          let sum = 0;
          for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
          const average = sum / dataArray.length;
          
          if (average > 90 && !emergencyActive) {
            triggerSOS();
          }
          if (isScreamGuardActive) animationFrame = requestAnimationFrame(checkVolume);
        };
        checkVolume();
      } catch (e) {
        console.error("Mic error for guard", e);
      }
    };

    if (isScreamGuardActive) {
      startScreamGuard();
    } else {
      if (guardAudioCtxRef.current) guardAudioCtxRef.current.close();
    }
    return () => cancelAnimationFrame(animationFrame);
  }, [isScreamGuardActive, emergencyActive]);

  const triggerSOS = useCallback(() => {
    setEmergencyActive(true);
    setStrobeActive(true);
    window.location.href = "tel:112";
    
    // Telegram/Location Simulation
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(pos => {
        console.log(`SOS Sent: ${pos.coords.latitude}, ${pos.coords.longitude}`);
        // Yahan Telegram API call add kar sakte hain
      });
    }

    setTimeout(() => {
      setStrobeActive(false);
      setStealthActive(true);
    }, 3000);
  }, []);

  const handleStealthTap = () => {
    const newCount = tapCount + 1;
    setTapCount(newCount);
    if (newCount >= 3) {
      window.location.reload();
    }
  };

  const manualLocation = () => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(pos => {
        const link = `http://maps.google.com/?q=${pos.coords.latitude},${pos.coords.longitude}`;
        window.open(`https://wa.me/?text=${encodeURIComponent("Safe check: " + link)}`, '_blank');
      });
    }
  };

  // --- RAKSHAK AI LOGIC ---
  const startCall = async () => {
    const apiKey = process.env.API_KEY;
    if (!apiKey) return;

    setIsCalling(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;
      const AudioContextClass = (window as any).AudioContext || (window as any).webkitAudioContext;
      const inCtx = new AudioContextClass({ sampleRate: 16000 });
      const outCtx = new AudioContextClass({ sampleRate: 24000 });
      audioCtxRef.current = { input: inCtx, output: outCtx };

      const ai = new GoogleGenAI({ apiKey });
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        callbacks: {
          onopen: () => {
            const source = inCtx.createMediaStreamSource(stream);
            const scriptProcessor = inCtx.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              if (isMuted) return;
              const inputData = e.inputBuffer.getChannelData(0);
              const int16 = new Int16Array(inputData.length);
              for (let i = 0; i < inputData.length; i++) int16[i] = inputData[i] * 32768;
              sessionPromise.then(session => session.sendRealtimeInput({ media: { data: encode(new Uint8Array(int16.buffer)), mimeType: 'audio/pcm;rate=16000' } }));
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
              activeSources.current.forEach(s => { try { s.stop(); } catch(e) {} });
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
      setIsCalling(false);
    }
  };

  const stopCall = () => {
    if (liveSessionRef.current) { liveSessionRef.current.close(); liveSessionRef.current = null; }
    if (audioCtxRef.current) { audioCtxRef.current.input.close(); audioCtxRef.current.output.close(); audioCtxRef.current = null; }
    if (micStreamRef.current) { micStreamRef.current.getTracks().forEach(t => t.stop()); micStreamRef.current = null; }
    activeSources.current.forEach(s => { try { s.stop(); } catch(e) {} });
    activeSources.current.clear();
    setIsCalling(false);
    setIsBhaiSpeaking(false);
  };

  return (
    <div className="min-h-screen bg-[#ffebee] font-['Outfit'] pb-24 transition-colors">
      
      {/* 🔴 OVERLAYS FOR EMERGENCY 🔴 */}
      {strobeActive && (
        <div className="fixed inset-0 z-[100] animate-[strobe_0.2s_infinite] pointer-events-none" />
      )}
      {stealthActive && (
        <div onClick={handleStealthTap} className="fixed inset-0 z-[101] bg-black flex items-center justify-center p-10">
          <p className="text-white/20 text-xs text-center">Tap 3 times to cancel stealth mode</p>
        </div>
      )}

      {/* 🛡️ SAFETY DASHBOARD 🛡️ */}
      <div className="max-w-md mx-auto p-6 space-y-4">
        <header className="py-8 text-center space-y-2">
          <h1 className="text-4xl font-black text-[#b71c1c] tracking-tighter uppercase italic">🛡️ Raksha Complete</h1>
          <p className="text-slate-500 font-bold text-sm tracking-widest uppercase">Ultimate Safety Protocol</p>
        </header>

        <button 
          onClick={() => setIsScreamGuardActive(!isScreamGuardActive)}
          className={`w-full py-6 rounded-2xl font-black text-lg shadow-xl transition-all flex flex-col items-center justify-center border-4 ${isScreamGuardActive ? 'bg-slate-900 border-amber-500 text-amber-500 animate-pulse' : 'bg-gradient-to-br from-amber-500 to-orange-600 border-white/20 text-white'}`}
        >
          <span className="text-2xl mb-1">{isScreamGuardActive ? '🔇 Deactivate Scream Guard' : '🔊 Activate Scream Guard'}</span>
          <span className="text-[10px] font-normal uppercase tracking-widest opacity-80">(Auto-SOS on Loud Noise)</span>
        </button>

        <button onClick={manualLocation} className="w-full py-5 bg-gradient-to-br from-emerald-600 to-teal-700 text-white rounded-2xl font-black text-lg shadow-lg flex items-center justify-center gap-3">
          📍 Share Location
        </button>

        <a href="tel:+918409681110" className="block">
          <button className="w-full py-5 bg-gradient-to-br from-blue-600 to-indigo-700 text-white rounded-2xl font-black text-lg shadow-lg flex items-center justify-center gap-3">
            📞 Call Family
          </button>
        </a>

        <div className="pt-4">
          <button 
            onClick={triggerSOS}
            className="w-full h-32 bg-gradient-to-br from-red-600 to-red-800 text-white rounded-3xl font-black text-3xl shadow-2xl border-4 border-red-200 animate-[pulse_1.5s_infinite] flex flex-col items-center justify-center"
          >
            🆘 SOS EMERGENCY
            <span className="text-sm font-normal mt-1 opacity-70">(Calls 112 + Records Evidence)</span>
          </button>
        </div>

        <div className="text-center pt-8">
           <button className="text-slate-400 font-bold text-xs uppercase tracking-widest hover:text-slate-600 transition-colors">
              📚 Class 12 Biology Notes (Secret Mode)
           </button>
        </div>
      </div>

      {/* 🤖 RAKSHAK FLOATING WIDGET 🤖 */}
      <div className="fixed bottom-6 right-6 z-[200] flex items-end justify-end pointer-events-none">
        {isRakshakOpen ? (
          <div className="pointer-events-auto w-[90vw] max-w-[400px] h-[80vh] bg-[#0a0a0c] rounded-[2.5rem] shadow-2xl border border-white/10 flex flex-col relative animate-widget overflow-hidden">
            <header className="p-6 flex items-center justify-between bg-black/40 backdrop-blur-md border-b border-white/5">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-gradient-to-tr from-indigo-600 to-fuchsia-600 rounded-xl flex items-center justify-center text-xl">🛡️</div>
                <h2 className="font-black text-white text-base">Rakshak Bhai</h2>
              </div>
              <button onClick={() => { stopCall(); setIsRakshakOpen(false); }} className="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center text-white">✕</button>
            </header>

            <main className="flex-1 flex flex-col items-center justify-center p-8 bg-black">
              {!isCalling ? (
                <div className="text-center space-y-8">
                  <h3 className="text-2xl font-black text-white">Bhai se baat karo?</h3>
                  <button onClick={startCall} className="w-full py-5 bg-indigo-600 text-white rounded-[1.5rem] font-black text-lg shadow-xl shadow-indigo-600/30">
                    📞 Start Call
                  </button>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-between h-full w-full py-4">
                  <div className={`w-44 h-44 rounded-full border-4 border-white/10 flex items-center justify-center transition-all ${isBhaiSpeaking ? 'scale-110 shadow-[0_0_40px_rgba(79,70,229,0.4)]' : ''}`}>
                    <span className="text-6xl">{isBhaiSpeaking ? '🗣️' : '🛡️'}</span>
                  </div>
                  <div className="text-center space-y-6">
                    <p className="text-indigo-400 font-bold animate-pulse">{isBhaiSpeaking ? 'Bhai is speaking...' : 'Bhai is listening...'}</p>
                    <button onClick={stopCall} className="w-20 h-20 bg-red-600 rounded-full flex items-center justify-center shadow-xl border-4 border-white/20">
                      <span className="text-3xl">📞</span>
                    </button>
                  </div>
                </div>
              )}
            </main>
          </div>
        ) : (
          <button 
            onClick={() => setIsRakshakOpen(true)}
            className="pointer-events-auto group relative w-16 h-16 bg-gradient-to-tr from-indigo-600 to-fuchsia-600 rounded-full shadow-2xl flex items-center justify-center text-3xl border-4 border-white"
          >
            <div className="absolute inset-0 bg-indigo-600 rounded-full animate-ping opacity-25"></div>
            📞
            <div className="absolute -top-12 right-0 bg-white text-indigo-700 px-3 py-1.5 rounded-xl shadow-lg text-[10px] font-black whitespace-nowrap animate-bounce">
               Bhai hai na! ✨
            </div>
          </button>
        )}
      </div>

    </div>
  );
};

export default App;
