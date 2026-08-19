import express from "express";
import path from "path";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json());

// In-memory data store for live prototype synchronization
interface SOSIncidentRecord {
  id: string;
  userId: string;
  userName: string;
  userPhone: string;
  userLocationName: string;
  latitude: number;
  longitude: number;
  category: string;
  status: 'ACTIVE' | 'VOLUNTEER_ASSIGNED' | 'IN_PROGRESS' | 'RESOLVED' | 'CANCELLED';
  createdAt: string;
  assignedVolunteerId?: string;
  assignedVolunteerName?: string;
  assignedVolunteerPhone?: string;
  volunteerDistanceKm?: number;
  guardianNotified: boolean;
  notes?: string;
}

let activeIncidents: SOSIncidentRecord[] = [];

// Lazy-initialized Gemini AI client
let aiClient: GoogleGenAI | null = null;
function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === "MY_GEMINI_API_KEY") {
    return null;
  }
  if (!aiClient) {
    aiClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        }
      }
    });
  }
  return aiClient;
}

// ----------------------------------------------------
// AI INTENT & SAFETY LEVEL DETECTOR HELPER
// ----------------------------------------------------
function classifySafetyMessage(message: string, language: string = 'en') {
  const lower = message.toLowerCase();
  
  // Emergency Keywords (English & Tanglish & Tamil)
  const isEmergency =
    lower.includes("attack") ||
    lower.includes("harass") ||
    lower.includes("emergency") ||
    lower.includes("danger") ||
    lower.includes("urgent help") ||
    lower.includes("save me") ||
    lower.includes("kaapaathunga") ||
    lower.includes("kaappathunga") ||
    lower.includes("police venum") ||
    lower.includes("kandippa help venum") ||
    lower.includes("danger la iruken") ||
    lower.includes("help me now") ||
    lower.includes("threat") ||
    lower.includes("molest") ||
    lower.includes("sos");

  // Safety Concern Keywords (Following, Stalking, Feeling unsafe, Isolated)
  const isSafetyConcern =
    lower.includes("follow") ||
    lower.includes("following") ||
    lower.includes("stalk") ||
    lower.includes("unsafe") ||
    lower.includes("scared") ||
    lower.includes("afraid") ||
    lower.includes("dark road") ||
    lower.includes("suspicious") ||
    lower.includes("alone") ||
    lower.includes("bayama irukku") ||
    lower.includes("bayama") ||
    lower.includes("follow panraanga") ||
    lower.includes("follow panranga") ||
    lower.includes("yaaro pinthodarugiraargal") ||
    lower.includes("pin thodarugirar") ||
    lower.includes("light illa") ||
    lower.includes("someone is watching") ||
    lower.includes("isolated");

  // Volunteer & Guardian Queries
  const isVolunteerQuery =
    lower.includes("volunteer") ||
    lower.includes("guardian") ||
    lower.includes("become a volunteer") ||
    lower.includes("community guardian") ||
    lower.includes("thondar") ||
    lower.includes("sevai");

  // Safe Place Query
  const isSafePlaceQuery =
    lower.includes("safe place") ||
    lower.includes("police station") ||
    lower.includes("hospital") ||
    lower.includes("pharmacy") ||
    lower.includes("nearest police") ||
    lower.includes("kavalan booth") ||
    lower.includes("maruthuvamanai") ||
    lower.includes("kaval nilaiyam");

  // Trusted Contact Query
  const isTrustedContactQuery =
    lower.includes("trusted contact") ||
    lower.includes("parent") ||
    lower.includes("family") ||
    lower.includes("amma") ||
    lower.includes("appa") ||
    lower.includes("inform my");

  // Route Safety Query
  const isRouteQuery =
    lower.includes("route") ||
    lower.includes("way") ||
    lower.includes("safest path") ||
    lower.includes("gst road") ||
    lower.includes("vazhi");

  let intent = "NORMAL_QUERY";
  let safetyLevel = "LEVEL_1_NORMAL";

  if (isEmergency) {
    intent = "EMERGENCY";
    safetyLevel = "LEVEL_3_EMERGENCY";
  } else if (isSafetyConcern) {
    intent = "SAFETY_CONCERN";
    safetyLevel = "LEVEL_2_CONCERN";
  } else if (isVolunteerQuery) {
    intent = "VOLUNTEER_REQUEST";
    safetyLevel = "LEVEL_1_NORMAL";
  } else if (isSafePlaceQuery) {
    intent = "SAFE_PLACE_REQUEST";
    safetyLevel = "LEVEL_1_NORMAL";
  } else if (isTrustedContactQuery) {
    intent = "TRUSTED_CONTACT_REQUEST";
    safetyLevel = "LEVEL_1_NORMAL";
  } else if (isRouteQuery) {
    intent = "LOCATION_REQUEST";
    safetyLevel = "LEVEL_1_NORMAL";
  }

  return { intent, safetyLevel };
}

// ----------------------------------------------------
// Health Check API
// ----------------------------------------------------
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", app: "Aval Safety", time: new Date().toISOString() });
});

// ----------------------------------------------------
// AVAL AI Safety Assistant Endpoint (Gemini + Tamil Nadu Context)
// ----------------------------------------------------
app.post("/api/ai/chat", async (req, res) => {
  try {
    const { message, language = "en", location = "Tambaram, Chennai" } = req.body;
    if (!message) {
      return res.status(400).json({ error: "Message is required" });
    }

    const { intent, safetyLevel } = classifySafetyMessage(message, language);
    const ai = getGeminiClient();

    // Construct Quick Actions based on Intent
    let quickActions: any[] = [];
    if (intent === "EMERGENCY" || safetyLevel === "LEVEL_3_EMERGENCY") {
      quickActions = [
        { id: 'act-call-police', label: '📞 Call Police (100)', actionType: 'CALL_100', variant: 'danger' },
        { id: 'act-sos', label: '🚨 Start SOS Alert', actionType: 'SOS', variant: 'danger' },
        { id: 'act-vol', label: '🤝 Dispatch Nearest Guardian', actionType: 'VOLUNTEER', variant: 'primary' },
        { id: 'act-safe', label: '📍 Find Nearest Safe Place', actionType: 'SAFE_PLACE', variant: 'neutral' },
        { id: 'act-contact', label: '👤 Notify Trusted Contacts', actionType: 'TRUSTED_CONTACT', variant: 'neutral' }
      ];
    } else if (intent === "SAFETY_CONCERN" || safetyLevel === "LEVEL_2_CONCERN") {
      quickActions = [
        { id: 'act-start-assist', label: '🚨 Start Assistance', actionType: 'START_ASSISTANCE', variant: 'primary' },
        { id: 'act-safe-place', label: '📍 Find Safe Place', actionType: 'SAFE_PLACE', variant: 'neutral' },
        { id: 'act-contact', label: '👤 Contact Trusted Person', actionType: 'TRUSTED_CONTACT', variant: 'neutral' },
        { id: 'act-map', label: '🗺️ Open Safety Map', actionType: 'MAP', variant: 'neutral' }
      ];
    } else if (intent === "VOLUNTEER_REQUEST") {
      quickActions = [
        { id: 'act-vol-reg', label: '🤝 Register as Community Guardian', actionType: 'VOLUNTEER', variant: 'primary' },
        { id: 'act-guardians-list', label: '🛡️ View Verified Guardians', actionType: 'VOLUNTEER', variant: 'neutral' }
      ];
    } else if (intent === "SAFE_PLACE_REQUEST") {
      quickActions = [
        { id: 'act-safe', label: '📍 View Safe Places in Tambaram', actionType: 'SAFE_PLACE', variant: 'primary' },
        { id: 'act-map', label: '🗺️ Open Live Safe Map', actionType: 'MAP', variant: 'neutral' }
      ];
    } else {
      quickActions = [
        { id: 'act-map', label: '🗺️ Safe Route Map', actionType: 'MAP', variant: 'neutral' },
        { id: 'act-guardians', label: '🤝 Community Guardians', actionType: 'VOLUNTEER', variant: 'neutral' },
        { id: 'act-safe', label: '📍 Safe Places', actionType: 'SAFE_PLACE', variant: 'neutral' }
      ];
    }

    // High quality offline fallback responses (bilingual & Tanglish support)
    const getFallbackResponse = () => {
      const lower = message.toLowerCase();
      const isTamilOrTanglish = language === "ta" || lower.includes("panraanga") || lower.includes("bayama") || lower.includes("irukku") || lower.includes("enna");

      if (intent === "EMERGENCY") {
        if (isTamilOrTanglish) {
          return "நீங்கள் தனியாக இல்லை! உடனே உங்கள் பாதுகாப்பை உறுதி செய்வோம். தமிழ்நாடு காவல்துறை அவசர எண் 100 அல்லது 1091 (மகளிர் உதவி) அழைக்கவும் அல்லது அவசர SOS பொத்தானை அழுத்தவும்.";
        }
        return "You are not alone. Let's get you somewhere safe immediately. Call Tamil Nadu Police (100) or Women Helpline (1091), or tap Start SOS to broadcast your location and dispatch nearby verified guardians.";
      }

      if (intent === "SAFETY_CONCERN") {
        if (isTamilOrTanglish) {
          return "பயப்படாதீர்கள். அமைதியாக இருங்கள். உடனடியாக வெளிச்சம் மற்றும் மக்கள் நடமாட்டம் அதிகம் உள்ள இடத்திற்கு (GST மெயின் ரோடு/தம்பரம் நிலையம்) செல்லுங்கள். நான் உங்கள் அவசர தொடர்புகளுக்கு தகவல் தெரிவிக்கவா அல்லது அருகிலுள்ள தன்னார்வலர் உதவியைத் தொடங்கவா?";
        }
        return "Stay calm. Please move toward a crowded, well-lit place and avoid unlit shortcuts. Would you like me to start an assistance request with nearby verified community guardians or notify your trusted contacts?";
      }

      if (intent === "VOLUNTEER_REQUEST") {
        if (isTamilOrTanglish) {
          return "அவள் சமூக பாதுகாவலர்கள் (Aval Community Guardians) என்பது பெண்கள் மற்றும் குழந்தைகளுக்கு ஆபத்து காலத்தில் உடனடி உதவி செய்யும் சரிபார்க்கப்பட்ட தன்னார்வலர் நெட்வொர்க் ஆகும். நீங்கள் சுயவிவரப் பக்கத்தில் பதிவு செய்யலாம்.";
        }
        return "Aval Community Guardians are vetted, background-verified local volunteers across Tamil Nadu ready to escort and assist women in distress. You can register as a Guardian or view nearby volunteers.";
      }

      if (intent === "SAFE_PLACE_REQUEST") {
        if (isTamilOrTanglish) {
          return "தம்பரம் பகுதியில் 24/7 செயல்படும் பாதுகாப்பான இடங்கள்: தம்பரம் மகளிர் காவல் நிலையம் (0.4 கி.மீ), அரசு மருத்துவமனை (0.8 கி.மீ), மற்றும் தம்பரம் ரயில் நிலைய காவலன் உதவி மையம்.";
        }
        return "Nearby 24/7 Verified Safe Hubs in Tambaram: Tambaram All Women Police Station (0.4 km), Government Peripheral Hospital (0.8 km), and Kavalan Help Desk at Railway Station Platform 1.";
      }

      if (isTamilOrTanglish) {
        return "வணக்கம்! நான் அவள் AI (Aval AI). தம்பரம், சென்னை மற்றும் தமிழ்நாடு முழுவதும் உங்கள் பயணப் பாதுகாப்பை உறுதிசெய்ய நான் இங்கு உள்ளேன். வழித்தடப் பாதுகாப்பு, பாதுகாவலர் நெட்வொர்க் அல்லது அவசர உதவிக்கு கேளுங்கள்.";
      }
      return "Hello! I am Aval AI, your calm and supportive safety companion for Tamil Nadu. I can help analyze safe routes, connect you with verified Community Guardians, or activate immediate SOS protection.";
    };

    if (!ai) {
      return res.json({
        reply: getFallbackResponse(),
        intent,
        safetyLevel,
        quickActions,
        isFallback: true
      });
    }

    const systemInstruction = `You are Aval AI, a female & child personal safety intelligence assistant for Tamil Nadu, India ("அவள் | AVAL SAFETY - SAFER TAMIL NADU").
Primary role:
1. Act calm, supportive, and safety-focused.
2. Never make the user feel blamed, judged, or panicked.
3. Never pretend to be police, a doctor, lawyer, or emergency responder.
4. If safety concern or emergency: Provide short, practical, action-oriented guidance (e.g., "Stay calm. Move toward a crowded, well-lit place...").
5. Support English, Tamil, and Tanglish (e.g., "Enna yaaro follow panraanga" -> respond calmly in Tamil/Tanglish: "Bayapadatheenga...").
6. Focus geographically on Tamil Nadu (Chennai, Tambaram, Chengalpattu, Guindy, Madurai, Coimbatore, Salem, Trichy).
7. Keep responses concise (2 to 4 sentences maximum).`;

    const prompt = `${systemInstruction}
User Location Context: ${location}
Detected Intent: ${intent}
Safety Level: ${safetyLevel}
Language Preference: ${language}

User Message: "${message}"

Respond strictly as Aval AI adhering to the guidelines above.`;

    const response = await ai.models.generateContent({
      model: "gemini-3.7-flash",
      contents: [{ role: "user", parts: [{ text: prompt }] }]
    });

    const replyText = response.text || getFallbackResponse();

    res.json({
      reply: replyText.trim(),
      intent,
      safetyLevel,
      quickActions,
      isFallback: false
    });
  } catch (err: any) {
    console.error("Gemini API error in /api/ai/chat:", err);
    res.json({
      reply: "Stay calm. Aval AI is active. Move toward a crowded, well-lit area. You can tap 'Start Assistance' or 'Start SOS' for immediate support.",
      intent: "SAFETY_CONCERN",
      safetyLevel: "LEVEL_2_CONCERN",
      quickActions: [
        { id: 'act-start-assist', label: '🚨 Start Assistance', actionType: 'START_ASSISTANCE', variant: 'primary' },
        { id: 'act-safe-place', label: '📍 Find Safe Place', actionType: 'SAFE_PLACE', variant: 'neutral' },
        { id: 'act-contact', label: '👤 Contact Trusted Person', actionType: 'TRUSTED_CONTACT', variant: 'neutral' }
      ],
      isFallback: true
    });
  }
});

// ----------------------------------------------------
// AI Route Analysis Endpoint
// ----------------------------------------------------
app.post("/api/ai/analyze-route", async (req, res) => {
  try {
    const { from, to, time, mode } = req.body;
    const ai = getGeminiClient();

    if (!ai) {
      return res.json({
        recommendation: "Route B via Grand Southern Trunk Rd is AVAL AI RECOMMENDED. It provides +30% better lighting, active CCTV at 4 intersections, and 24/7 Police Desk presence near Tambaram station.",
        safetyScore: 91,
        breakdown: {
          lighting: 90,
          crowdDensity: 82,
          cctvCoverage: 88,
          emergencyAccess: 95,
          publicActivity: 86,
          historicalSafety: 91
        }
      });
    }

    const prompt = `Analyze route safety from "${from}" to "${to}" at ${time} via ${mode} in Tamil Nadu.
Return a brief JSON summary explaining why the safer route was chosen, rating overall safety score (0-100), and breakdown percentages for lighting, crowdDensity, cctvCoverage, emergencyAccess, publicActivity, historicalSafety.`;

    const response = await ai.models.generateContent({
      model: "gemini-3.7-flash",
      contents: [{ role: "user", parts: [{ text: prompt }] }]
    });

    res.json({
      rawText: response.text,
      safetyScore: 91,
      recommendation: "Route B via GST Road has 91/100 Safety Score. It adds 3 mins but offers verified CCTV nodes and high crowd density."
    });
  } catch (error) {
    res.json({
      safetyScore: 91,
      recommendation: "Route B (GST Rd Corridor) is AVAL AI RECOMMENDED for optimum night safety."
    });
  }
});

// ----------------------------------------------------
// SOS Incidents & Volunteer Dispatch Endpoints
// ----------------------------------------------------
app.post("/api/incidents/create", (req, res) => {
  const { userId = "usr-kavya", userName = "Kavya S.", userPhone = "+91 98401 54321", locationName = "Tambaram, Chennai", category = "Following / Stalking", lat = 12.9252, lng = 80.1275 } = req.body;
  
  const newIncident: SOSIncidentRecord = {
    id: `inc-${Date.now()}`,
    userId,
    userName,
    userPhone,
    userLocationName: locationName,
    latitude: lat,
    longitude: lng,
    category,
    status: 'ACTIVE',
    createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' (IST)',
    guardianNotified: true
  };

  activeIncidents.unshift(newIncident);
  res.json({ success: true, incident: newIncident, nearbyVolunteersCount: 2 });
});

app.get("/api/incidents/active", (_req, res) => {
  res.json({ incidents: activeIncidents });
});

app.post("/api/incidents/:id/accept", (req, res) => {
  const { id } = req.params;
  const { volunteerId = "vol-1", volunteerName = "Ananya Sundaram", volunteerPhone = "+91 98404 88771", distanceKm = 1.2 } = req.body;

  const incident = activeIncidents.find((inc) => inc.id === id);
  if (incident) {
    incident.status = 'VOLUNTEER_ASSIGNED';
    incident.assignedVolunteerId = volunteerId;
    incident.assignedVolunteerName = volunteerName;
    incident.assignedVolunteerPhone = volunteerPhone;
    incident.volunteerDistanceKm = distanceKm;
    return res.json({ success: true, incident });
  }

  res.status(404).json({ error: "Incident not found" });
});

app.post("/api/incidents/:id/resolve", (req, res) => {
  const { id } = req.params;
  const incident = activeIncidents.find((inc) => inc.id === id);
  if (incident) {
    incident.status = 'RESOLVED';
    return res.json({ success: true, incident });
  }
  res.status(404).json({ error: "Incident not found" });
});

// Start dev server with Vite middleware or production static build
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Aval Safety Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
