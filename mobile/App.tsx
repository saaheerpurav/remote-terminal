import { Ionicons } from "@expo/vector-icons";
import * as ScreenOrientation from "expo-screen-orientation";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Dimensions,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  type NativeSyntheticEvent,
  type NativeScrollEvent,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View
} from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";

type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

type BridgeEvent =
  | {
      type: "hello";
      mode: "monitor" | "pty";
      sessionId: string;
      cwd: string;
      startedAt: string;
      hasPty: boolean;
    }
  | {
      type: "terminal";
      sessionId: string;
      data: string;
      at: string;
    }
  | {
      type: "screen";
      sessionId: string;
      text: string;
      lines: string[];
      cols: number;
      rows: number;
      at: string;
    }
  | {
      type: "status";
      sessionId: string;
      status: "starting" | "running" | "exited" | "error";
      message?: string;
      code?: number;
      at: string;
    }
  | {
      type: "hook";
      sessionId: string;
      source: string;
      payload: unknown;
      at: string;
    };

const DEFAULT_URL = "https://vividly-unaccountable-naomi.ngrok-free.dev";
const DEFAULT_TOKEN = "rtJ_n4gnS4Bti5DJN3WH2zb1ocuj3TnTY_9OQkhVdSg";
const MAX_TERMINAL_CHARS = 50000;
const CHROME_ANIMATION_MS = 240;
const COMMAND_BAR_HEIGHT = 48;
const COMMAND_BAR_GAP = 8;
const KEYBOARD_COMMAND_BAR_GAP = 24;
const FALLBACK_KEYBOARD_HEIGHT = 320;

export default function App() {
  return (
    <SafeAreaProvider>
      <RemoteTerminalApp />
    </SafeAreaProvider>
  );
}

function RemoteTerminalApp() {
  const insets = useSafeAreaInsets();
  const dimensions = useWindowDimensions();
  const socketRef = useRef<WebSocket | null>(null);
  const scrollRef = useRef<ScrollView | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const chromeAnimation = useRef(new Animated.Value(1)).current;
  const [bridgeUrl, setBridgeUrl] = useState(DEFAULT_URL);
  const [token, setToken] = useState(DEFAULT_TOKEN);
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [mode, setMode] = useState<"monitor" | "pty" | null>(null);
  const [terminalText, setTerminalText] = useState("");
  const [eventText, setEventText] = useState("");
  const [input, setInput] = useState("");
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  const isConnected = connectionState === "connected";
  const isLandscape = dimensions.width > dimensions.height;
  const canSendInput = connectionState === "connected" && mode === "pty";
  const connectionLabel = `${connectionState.charAt(0).toUpperCase()}${connectionState.slice(1)}`;

  useEffect(() => {
    Animated.timing(chromeAnimation, {
      duration: CHROME_ANIMATION_MS,
      toValue: isConnected ? 0 : 1,
      useNativeDriver: false
    }).start();
  }, [chromeAnimation, isConnected]);

  useEffect(() => {
    void setTerminalOrientationLock(isConnected);

    return () => {
      void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => undefined);
    };
  }, [isConnected]);

  const headerChromeStyle = {
    maxHeight: chromeAnimation.interpolate({
      inputRange: [0, 1],
      outputRange: [0, 72]
    }),
    marginBottom: chromeAnimation.interpolate({
      inputRange: [0, 1],
      outputRange: [0, 12]
    }),
    opacity: chromeAnimation
  };

  const inputChromeStyle = {
    maxHeight: chromeAnimation.interpolate({
      inputRange: [0, 1],
      outputRange: [0, 96]
    }),
    marginBottom: chromeAnimation.interpolate({
      inputRange: [0, 1],
      outputRange: [0, 8]
    }),
    opacity: chromeAnimation
  };

  const commandBarBottom = keyboardHeight > 0
    ? keyboardHeight + KEYBOARD_COMMAND_BAR_GAP
    : insets.bottom + COMMAND_BAR_GAP;
  const terminalBottomReserve = isConnected
    ? commandBarBottom + COMMAND_BAR_HEIGHT + COMMAND_BAR_GAP + 4
    : Math.max(24, insets.bottom);

  const terminalFrameStyle = {
    borderRadius: chromeAnimation.interpolate({
      inputRange: [0, 1],
      outputRange: [0, 8]
    }),
    marginBottom: chromeAnimation.interpolate({
      inputRange: [0, 1],
      outputRange: [terminalBottomReserve, terminalBottomReserve + 4]
    }),
    marginHorizontal: chromeAnimation.interpolate({
      inputRange: [0, 1],
      outputRange: [0, 16]
    })
  };

  const commandBarStyle = {
    bottom: commandBarBottom
  };

  const wsUrl = useMemo(() => {
    const trimmed = bridgeUrl.trim().replace(/\/+$/, "");
    if (!trimmed) {
      return "";
    }
    const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    return `${withProtocol.replace(/^http/i, "ws")}/ws?token=${encodeURIComponent(token)}`;
  }, [bridgeUrl, token]);

  const connect = useCallback(() => {
    if (!wsUrl) {
      return;
    }

    socketRef.current?.close();
    setConnectionState("connecting");
    setTerminalText("");
    setEventText("");
    shouldStickToBottomRef.current = true;

    const socket = new (WebSocket as typeof WebSocket & {
      new (url: string, protocols?: string | string[], options?: { headers?: Record<string, string> }): WebSocket;
    })(wsUrl, undefined, {
      headers: {
        "ngrok-skip-browser-warning": "true"
      }
    });
    socketRef.current = socket;

    socket.onopen = () => {
      setConnectionState("connected");
    };

    socket.onmessage = (message) => {
      const event = parseBridgeEvent(message.data);
      if (!event) {
        return;
      }
      handleBridgeEvent(event);
    };

    socket.onerror = () => {
      setConnectionState("error");
    };

    socket.onclose = () => {
      if (socketRef.current === socket) {
        setConnectionState("disconnected");
        socketRef.current = null;
      }
    };
  }, [handleBridgeEvent, wsUrl]);

  const disconnect = useCallback(() => {
    socketRef.current?.close();
    socketRef.current = null;
    setConnectionState("disconnected");
  }, []);

  const sendInput = useCallback((value: string) => {
    if (!value || !canSendInput || socketRef.current?.readyState !== WebSocket.OPEN) {
      return;
    }

    socketRef.current.send(JSON.stringify({ type: "submit", data: value, key: "enter" }));
    setInput("");
    Keyboard.dismiss();
  }, [canSendInput]);

  const sendCtrlC = useCallback(() => {
    if (!canSendInput || socketRef.current?.readyState !== WebSocket.OPEN) {
      return;
    }
    socketRef.current.send(JSON.stringify({ type: "input", data: "\u0003" }));
  }, [canSendInput]);

  const statusColor = connectionState === "connected"
    ? "#2f855a"
    : connectionState === "connecting"
      ? "#b7791f"
      : connectionState === "error"
        ? "#c53030"
        : "#718096";

  const handleTerminalScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distanceFromBottom = contentSize.height - (contentOffset.y + layoutMeasurement.height);
    shouldStickToBottomRef.current = distanceFromBottom < 48;
  }, []);

  const scrollTerminalToBottom = useCallback(() => {
    if (!shouldStickToBottomRef.current) {
      return;
    }
    requestAnimationFrame(() => {
      scrollRef.current?.scrollToEnd({ animated: false });
    });
  }, []);

  const setKeyboardHeightFromEvent = useCallback((event: Parameters<typeof Keyboard.scheduleLayoutAnimation>[0]) => {
    const screenHeight = Dimensions.get("window").height;
    const measuredHeight = Math.max(
      event.endCoordinates.height,
      screenHeight - event.endCoordinates.screenY
    );
    setKeyboardHeight(Math.max(0, measuredHeight));
  }, []);

  const handleCommandFocus = useCallback(() => {
    const measuredHeight = Keyboard.metrics()?.height;
    setKeyboardHeight(measuredHeight ?? (isLandscape ? 220 : FALLBACK_KEYBOARD_HEIGHT));

    setTimeout(() => {
      const delayedHeight = Keyboard.metrics()?.height;
      setKeyboardHeight(delayedHeight ?? (isLandscape ? 220 : FALLBACK_KEYBOARD_HEIGHT));
      scrollTerminalToBottom();
    }, 120);
  }, [isLandscape, scrollTerminalToBottom]);

  useEffect(() => {
    const showEvent = Platform.OS === "ios" ? "keyboardWillChangeFrame" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";

    const showSubscription = Keyboard.addListener(showEvent, (event) => {
      Keyboard.scheduleLayoutAnimation(event);
      setKeyboardHeightFromEvent(event);
      scrollTerminalToBottom();
    });
    const hideSubscription = Keyboard.addListener(hideEvent, (event) => {
      Keyboard.scheduleLayoutAnimation(event);
      setKeyboardHeight(0);
      scrollTerminalToBottom();
    });

    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, [scrollTerminalToBottom, setKeyboardHeightFromEvent]);

  return (
    <View
      style={[
        styles.safeArea,
        isConnected && styles.connectedSafeArea,
        {
          paddingLeft: isConnected ? insets.left : 0,
          paddingRight: isConnected ? insets.right : 0,
          paddingTop: insets.top
        }
      ]}
    >
      <StatusBar style={isConnected ? "light" : "dark"} />
      <View
        style={[
          styles.container,
          isConnected && styles.connectedContainer
        ]}
      >
        <Animated.View
          pointerEvents={isConnected ? "none" : "auto"}
          style={[styles.chromeSection, headerChromeStyle]}
        >
          <View style={styles.header}>
            <View>
              <Text style={styles.title}>RemoteTerminal</Text>
              <Text style={styles.subtitle}>
                {mode ? `${mode.toUpperCase()} session` : "No active session"}
              </Text>
            </View>
            <View style={[styles.statusPill, { borderColor: statusColor }]}>
              <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
              <Text style={styles.statusText}>{connectionLabel}</Text>
            </View>
          </View>
        </Animated.View>

          <View style={[
            styles.settings,
            isConnected && styles.connectedSettings,
            isConnected && isLandscape && styles.connectedLandscapeSettings
          ]}>
            <Animated.View
              pointerEvents={isConnected ? "none" : "auto"}
              style={[styles.inputChrome, inputChromeStyle]}
            >
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              onChangeText={setBridgeUrl}
              placeholder="https://your-fixed-domain.ngrok.app"
              placeholderTextColor="#d1d5db"
              style={styles.input}
              value={bridgeUrl}
            />
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={setToken}
              placeholder="RMTERM_TOKEN"
              placeholderTextColor="#d1d5db"
              secureTextEntry
              style={styles.input}
              value={token}
            />
            </Animated.View>
            <View style={[styles.actionRow, isConnected && styles.connectedActionRow]}>
              <IconButton
                disabled={connectionState === "connecting"}
                edgeToEdge={isConnected}
                icon={connectionState === "connected" ? "close" : "radio"}
                inverted={isConnected}
                label={connectionState === "connected" ? "Disconnect" : "Connect"}
                onPress={connectionState === "connected" ? disconnect : connect}
              />
              <IconButton
                disabled={!canSendInput}
                edgeToEdge={isConnected}
                icon="stop-circle"
                inverted={isConnected}
                label="Ctrl-C"
                onPress={sendCtrlC}
              />
            </View>
          </View>

          <Animated.View style={[styles.terminalFrame, terminalFrameStyle]}>
            <ScrollView
              alwaysBounceVertical
              keyboardShouldPersistTaps="handled"
              nestedScrollEnabled
              onContentSizeChange={scrollTerminalToBottom}
              onScroll={handleTerminalScroll}
              onScrollBeginDrag={Keyboard.dismiss}
              scrollEventThrottle={80}
              ref={scrollRef}
              contentContainerStyle={styles.terminalContent}
              style={styles.terminal}
            >
              <Text style={styles.terminalText}>
                {terminalText || eventText || "Connect to rmterm to watch terminal output."}
              </Text>
            </ScrollView>
          </Animated.View>

          {isConnected && (
            <View style={[
              styles.commandBar,
              commandBarStyle,
              styles.connectedCommandBar,
              isLandscape && styles.connectedLandscapeCommandBar
            ]}>
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              editable={canSendInput}
              onChangeText={setInput}
              onFocus={handleCommandFocus}
              onSubmitEditing={() => sendInput(input)}
              placeholderTextColor="#d1d5db"
              placeholder={canSendInput ? "Type a message or command" : "Input available in PTY mode"}
              returnKeyType="send"
              style={[
                styles.commandInput,
                isConnected && styles.connectedCommandInput,
                !canSendInput && styles.disabledInput
              ]}
              value={input}
            />
            <Pressable
              accessibilityLabel="Send input"
              disabled={!canSendInput || !input}
              onPress={() => sendInput(input)}
              style={({ pressed }) => [
                styles.sendButton,
                (!canSendInput || !input) && styles.disabledButton,
                pressed && canSendInput && styles.pressed
              ]}
            >
              <Ionicons color="#ffffff" name="send" size={20} />
            </Pressable>
          </View>
          )}
        </View>
    </View>
  );

  function handleBridgeEvent(event: BridgeEvent) {
    if (event.type === "hello") {
      setMode(event.mode);
      return;
    }

    if (event.type === "terminal") {
      setTerminalText((current) => trimTerminal(`${current}${stripAnsi(event.data)}`));
      return;
    }

    if (event.type === "screen") {
      setTerminalText(event.text);
      return;
    }

    if (event.type === "status") {
      const line = `[${new Date(event.at).toLocaleTimeString()}] status: ${event.status}${typeof event.code === "number" ? ` (${event.code})` : ""}\n`;
      setTerminalText((current) => trimTerminal(`${current}${line}`));
      return;
    }

    if (event.type === "hook") {
      const line = `[${new Date(event.at).toLocaleTimeString()}] hook:${event.source} ${JSON.stringify(event.payload)}\n`;
      setEventText((current) => trimTerminal(`${current}${line}`));
    }
  }

}

async function setTerminalOrientationLock(isConnected: boolean) {
  if (!isConnected) {
    await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
    return;
  }

  try {
    await ScreenOrientation.lockPlatformAsync({
      screenOrientationArrayIOS: [
        ScreenOrientation.Orientation.PORTRAIT_UP,
        ScreenOrientation.Orientation.LANDSCAPE_LEFT,
        ScreenOrientation.Orientation.LANDSCAPE_RIGHT
      ],
      screenOrientationConstantAndroid: -1,
      screenOrientationLockWeb: ScreenOrientation.WebOrientationLock.ANY
    });
  } catch {
    await ScreenOrientation.unlockAsync();
  }
}

function IconButton({
  disabled,
  edgeToEdge,
  icon,
  inverted,
  label,
  onPress
}: {
  disabled?: boolean;
  edgeToEdge?: boolean;
  icon: keyof typeof Ionicons.glyphMap;
  inverted?: boolean;
  label: string;
  onPress: () => void;
}) {
  const iconColor = disabled ? "#6b7280" : inverted ? "#e5e7eb" : "#1a202c";

  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.iconButton,
        edgeToEdge && styles.edgeIconButton,
        inverted && styles.invertedIconButton,
        disabled && styles.disabledButton,
        pressed && !disabled && styles.pressed
      ]}
    >
      <Ionicons color={iconColor} name={icon} size={18} />
      <Text style={[
        styles.iconButtonText,
        inverted && styles.invertedIconButtonText,
        disabled && styles.disabledText
      ]}>{label}</Text>
    </Pressable>
  );
}

function parseBridgeEvent(raw: unknown): BridgeEvent | null {
  if (typeof raw !== "string") {
    return null;
  }
  try {
    return JSON.parse(raw) as BridgeEvent;
  } catch {
    return null;
  }
}

function trimTerminal(value: string) {
  if (value.length <= MAX_TERMINAL_CHARS) {
    return value;
  }
  return value.slice(value.length - MAX_TERMINAL_CHARS);
}

function stripAnsi(value: string) {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[=>]/g, "")
    .replace(/\r(?!\n)/g, "\n");
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#f7fafc"
  },
  connectedSafeArea: {
    backgroundColor: "#111827"
  },
  container: {
    flex: 1,
    position: "relative"
  },
  connectedContainer: {
    position: "relative"
  },
  chromeSection: {
    overflow: "hidden",
    paddingHorizontal: 16,
    paddingTop: 16
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between"
  },
  title: {
    color: "#1a202c",
    fontSize: 24,
    fontWeight: "700"
  },
  subtitle: {
    color: "#4a5568",
    fontSize: 13,
    marginTop: 2
  },
  statusPill: {
    alignItems: "center",
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6
  },
  statusDot: {
    borderRadius: 5,
    height: 10,
    width: 10
  },
  statusText: {
    color: "#2d3748",
    fontSize: 12,
    fontWeight: "600"
  },
  settings: {
    marginBottom: 12,
    paddingHorizontal: 16
  },
  connectedSettings: {
    marginBottom: 8,
    paddingHorizontal: 0
  },
  connectedLandscapeSettings: {
    marginBottom: 6
  },
  inputChrome: {
    gap: 8,
    overflow: "hidden"
  },
  input: {
    backgroundColor: "#ffffff",
    borderColor: "#cbd5e0",
    borderRadius: 8,
    borderWidth: 1,
    color: "#1a202c",
    fontSize: 14,
    minHeight: 44,
    paddingHorizontal: 12
  },
  actionRow: {
    flexDirection: "row",
    gap: 8
  },
  connectedActionRow: {
    gap: 8,
    paddingHorizontal: 8,
    width: "100%"
  },
  iconButton: {
    alignItems: "center",
    backgroundColor: "#edf2f7",
    borderColor: "#cbd5e0",
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: "row",
    flex: 1,
    gap: 8,
    justifyContent: "center",
    minHeight: 42,
    paddingHorizontal: 12
  },
  edgeIconButton: {
    borderRadius: 8
  },
  invertedIconButton: {
    backgroundColor: "#111827",
    borderColor: "#374151"
  },
  iconButtonText: {
    color: "#1a202c",
    fontSize: 14,
    fontWeight: "600"
  },
  invertedIconButtonText: {
    color: "#e5e7eb"
  },
  disabledButton: {
    opacity: 0.5
  },
  disabledText: {
    color: "#718096"
  },
  pressed: {
    opacity: 0.75
  },
  terminalFrame: {
    backgroundColor: "#111827",
    flex: 1,
    overflow: "hidden"
  },
  terminal: {
    backgroundColor: "#111827",
    flex: 1
  },
  terminalContent: {
    padding: 12
  },
  terminalText: {
    color: "#e5e7eb",
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
    fontSize: 12,
    lineHeight: 17
  },
  commandBar: {
    alignItems: "center",
    backgroundColor: "#f7fafc",
    height: COMMAND_BAR_HEIGHT,
    left: 0,
    position: "absolute",
    right: 0,
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 16,
    zIndex: 10
  },
  connectedCommandBar: {
    backgroundColor: "#111827",
    paddingHorizontal: 8
  },
  connectedLandscapeCommandBar: {
    paddingHorizontal: 10
  },
  commandInput: {
    backgroundColor: "#ffffff",
    borderColor: "#cbd5e0",
    borderRadius: 8,
    borderWidth: 1,
    color: "#1a202c",
    flex: 1,
    fontSize: 15,
    height: COMMAND_BAR_HEIGHT,
    paddingHorizontal: 12,
    paddingVertical: 0
  },
  connectedCommandInput: {
    backgroundColor: "#111827",
    borderColor: "#374151",
    color: "#e5e7eb"
  },
  disabledInput: {
    backgroundColor: "#edf2f7",
    color: "#718096"
  },
  sendButton: {
    alignItems: "center",
    backgroundColor: "#2563eb",
    borderRadius: 8,
    height: COMMAND_BAR_HEIGHT,
    justifyContent: "center",
    width: COMMAND_BAR_HEIGHT
  }
});
