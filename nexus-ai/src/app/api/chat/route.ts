import { NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';
import { prisma } from '@/lib/prisma';

const PERSONA_PROMPTS: Record<string, string> = {
  architect:
    'You are Nexus Architect, a Principal Systems Architect. Provide clean High-Level Designs (HLD), ASCII architecture diagrams, scalable database schemas, and production-ready code with clear trade-offs.',
  reviewer:
    'You are Nexus Reviewer, a Staff Security & Performance Engineer. Analyze code for time/space complexity, edge cases, race conditions, and security flaws. Always provide refactored, idiomatic solutions.',
  mentor:
    'You are Nexus Mentor, an empathetic Full-Stack Engineering Coach. Break down complex CS concepts clearly using first principles, practical analogies, and step-by-step TypeScript/Python examples.',
};

export async function POST(req: Request) {
  const startTime = Date.now();

  try {
    const { sessionId, message, persona = 'architect' } = await req.json();

    if (!message || typeof message !== 'string') {
      return NextResponse.json({ error: 'Message payload is required.' }, { status: 400 });
    }

    // 1. Resolve or create the ChatSession in SQLite
    let currentSessionId = sessionId;
    if (!currentSessionId) {
      const newSession = await prisma.chatSession.create({
        data: {
          title: message.slice(0, 42) + (message.length > 42 ? '...' : ''),
          persona,
        },
      });
      currentSessionId = newSession.id;
    }

    // 2. Save User Message to Database
    await prisma.message.create({
      data: {
        sessionId: currentSessionId,
        role: 'user',
        content: message,
      },
    });

    // 3. Retrieve prior conversation history for context window
    const previousMessages = await prisma.message.findMany({
      where: { sessionId: currentSessionId },
      orderBy: { createdAt: 'asc' },
      take: 14,
    });

    // 4. Generate AI Response (with graceful fallback if API key is missing)
    let aiResponseText = '';
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey || apiKey === 'your_google_gemini_api_key_here') {
      aiResponseText = `### ⚡ Demo Mode Active (No API Key Detected)\n\nYou asked: **"${message}"**\n\nTo enable live Gemini inference, add your \`GEMINI_API_KEY\` to the \`.env\` file and restart the dev server.\n\n\`\`\`typescript\n// Your SQLite Database is already working!\nconst status = {\n  database: "Connected (Prisma + SQLite)",\n  sessionId: "${currentSessionId}",\n  persona: "${persona}"\n};\n\`\`\``;
    } else {
      const ai = new GoogleGenAI({ apiKey });
      const formattedHistory = previousMessages.map((msg) => ({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }],
      }));

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: formattedHistory,
        config: {
          systemInstruction: PERSONA_PROMPTS[persona] || PERSONA_PROMPTS.architect,
          temperature: 0.4,
        },
      });

      aiResponseText = response.text || 'Unable to synthesize response.';
    }

    const latencyMs = Date.now() - startTime;

    // 5. Save Assistant Message & Telemetry to Database
    const savedAssistantMsg = await prisma.message.create({
      data: {
        sessionId: currentSessionId,
        role: 'assistant',
        content: aiResponseText,
        latencyMs,
      },
    });

    await prisma.chatSession.update({
      where: { id: currentSessionId },
      data: { updatedAt: new Date() },
    });

    return NextResponse.json({
      sessionId: currentSessionId,
      message: savedAssistantMsg,
    });
  } catch (error: unknown) {
    console.error('AI Agent Error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal AI Orchestration Error';
    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    );
  }
}