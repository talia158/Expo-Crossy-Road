import { GLView } from "expo-gl";
import React, { Component } from "react";
import {
  Animated,
  Dimensions,
  StyleSheet,
  Platform,
  Vibration,
  View,
  useColorScheme,
} from "react-native";

import GestureRecognizer, { swipeDirections } from "@/components/GestureView";
import Score from "@/components/ScoreText";
import Engine from "@/GameEngine";
import DatasetController from "@/DatasetController";
import State from "@/state";
import CharacterSelectScreen from "@/screens/CharacterSelectScreen";
import GameOverScreen from "@/screens/GameOverScreen";
import HomeScreen from "@/screens/HomeScreen";
import SettingsScreen from "@/screens/SettingsScreen";
import GameContext from "@/context/GameContext";

const DEBUG_CAMERA_CONTROLS = false;

class Game extends Component {
  /// Reserve State for UI related updates...
  state = {
    ready: false,
    score: 0,
    viewKey: 0,
    gameState: State.Game.none,
    showSettings: false,
    showCharacterSelect: false,
    // gameState: State.Game.gameOver
  };

  transitionScreensValue = new Animated.Value(1);

  UNSAFE_componentWillReceiveProps(nextProps, nextState) {
    if (nextState.gameState && nextState.gameState !== this.state.gameState) {
      this.updateWithGameState(nextState.gameState, this.state.gameState);
    }
    if (this.engine && nextProps.character !== this.props.character) {
      this.engine._hero.setCharacter(nextProps.character);
    }
  }

  transitionToGamePlayingState = () => {
    Animated.timing(this.transitionScreensValue, {
      toValue: 0,
      useNativeDriver: true,
      duration: 200,
      onComplete: ({ finished }) => {
        this.engine.setupGame(this.props.character);
        this.engine.init();

        if (finished) {
          Animated.timing(this.transitionScreensValue, {
            toValue: 1,
            useNativeDriver: true,
            duration: 300,
          }).start();
        }
      },
    }).start();
  };

  updateWithGameState = (gameState) => {
    if (!gameState) throw new Error("gameState cannot be undefined");

    if (gameState === this.state.gameState) {
      return;
    }
    const lastState = this.state.gameState;

    this.setState({ gameState });
    this.engine.gameState = gameState;
    const { playing, gameOver, paused, none } = State.Game;
    switch (gameState) {
      case playing:
        if (lastState === paused) {
          this.engine.unpause();
        } else if (lastState !== none) {
          this.transitionToGamePlayingState();
        } else {
          // Coming straight from the menu.
          this.engine._hero.stopIdle();
          this.onSwipe(swipeDirections.SWIPE_UP);
        }

        break;
      case gameOver:
        break;
      case paused:
        this.engine.pause();
        break;
      case none:
        if (lastState === gameOver) {
          this.transitionToGamePlayingState();
        }
        this.newScore();

        break;
      default:
        break;
    }
  };

  componentWillUnmount() {
    cancelAnimationFrame(this.engine.raf);
    // Dimensions.removeEventListener("change", this.onScreenResize);
  }

  async componentDidMount() {
    // AudioManager.sounds.bg_music.setVolumeAsync(0.05);
    // await AudioManager.playAsync(
    //   AudioManager.sounds.bg_music, true
    // );

    Dimensions.addEventListener("change", this.onScreenResize);
  }

  onScreenResize = ({ window }) => {
    this.engine.updateScale();
  };

  UNSAFE_componentWillMount() {
    this.engine = new Engine();
    // this.engine.hideShadows = this.hideShadows;
    this.engine.onUpdateScore = (position) => {
      if (this.state.score < position) {
        this.setState({ score: position });
      }
    };
    this.engine.onGameInit = () => {
      this.setState({ score: 0 });
    };
    this.engine._isGameStateEnded = () => {
      return this.state.gameState !== State.Game.playing;
    };
    this.engine.onGameReady = () => {
      this.setState({ ready: true });
      if (typeof window !== "undefined") {
        const controller = new DatasetController(this.engine);
        (window as any).__crossyDataset = controller;
        (window as any).__crossyEngine = this.engine;
      }
    };
    this.engine.onGameEnded = () => {
      this.setState({ gameState: State.Game.gameOver });
      // this.props.navigation.navigate('GameOver')
    };
    this.engine.setupGame(this.props.character);
    this.engine.init();
  }

  newScore = () => {
    Vibration.cancel();
    // this.props.setGameState(State.Game.playing);
    this.setState({ score: 0 });
    this.engine.init();
  };

  onSwipe = (gestureName) => this.engine.moveWithDirection(gestureName);

  renderGame = () => {
    if (!this.state.ready) return;

    return (
      <View style={{ flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center" }}>
        <GestureView
          pointerEvents={DEBUG_CAMERA_CONTROLS ? "none" : undefined}
          onStartGesture={this.engine.beginMoveWithDirection}
          onSwipe={this.onSwipe}
          style={{ alignItems: "center", justifyContent: "center" }}
        >
          <GLView
            style={{ width: 240, height: 480, overflow: "hidden" }}
            onContextCreate={this.engine._onGLContextCreate}
          />
        </GestureView>
        <FootprintCanvas engine={this.engine} />
      </View>
    );
  };

  renderGameOver = () => {
    if (this.state.gameState !== State.Game.gameOver) {
      return null;
    }

    return (
      <View style={StyleSheet.absoluteFillObject}>
        <GameOverScreen
          showSettings={() => {
            this.setState({ showSettings: true });
          }}
          setGameState={(state) => {
            this.updateWithGameState(state);
          }}
        />
      </View>
    );
  };

  renderHomeScreen = () => {
    if (this.state.gameState !== State.Game.none) {
      return null;
    }

    return (
      <View style={StyleSheet.absoluteFillObject}>
        <HomeScreen
          onPlay={() => {
            this.updateWithGameState(State.Game.playing);
          }}
          onShowCharacterSelect={() => {
            this.setState({ showCharacterSelect: true });
          }}
        />
      </View>
    );
  };

  renderSettingsScreen() {
    return (
      <View style={StyleSheet.absoluteFillObject}>
        <SettingsScreen
          goBack={() => this.setState({ showSettings: false })}
          setCharacter={this.props.setCharacter}
        />
      </View>
    );
  }

  renderCharacterSelectScreen() {
    return (
      <View style={StyleSheet.absoluteFillObject}>
        <CharacterSelectScreen
          navigation={{
            goBack: () => this.setState({ showCharacterSelect: false }),
          }}
          setCharacter={this.props.setCharacter}
        />
      </View>
    );
  }

  render() {
    const { isDarkMode, isPaused } = this.props;

    return (
      <View
        pointerEvents="box-none"
        style={[
          StyleSheet.absoluteFill,
          { flex: 1, backgroundColor: "#87C6FF" },
          Platform.select({
            web: { position: "fixed" },
            default: { position: "absolute" },
          }),
          this.props.style,
        ]}
      >
        <Animated.View
          style={{ flex: 1, opacity: this.transitionScreensValue }}
        >
          {this.renderGame()}
        </Animated.View>
        <Score
          score={this.state.score}
          gameOver={this.state.gameState === State.Game.gameOver}
        />
        {this.renderGameOver()}

        {this.renderHomeScreen()}

        {this.state.showSettings && this.renderSettingsScreen()}

        {this.state.showCharacterSelect && this.renderCharacterSelectScreen()}

        {isPaused && (
          <View
            style={[
              StyleSheet.absoluteFill,
              {
                backgroundColor: "rgba(105, 201, 230, 0.8)",
                justifyContent: "center",
                alignItems: "center",
              },
            ]}
          />
        )}
      </View>
    );
  }
}

const GestureView = ({ onStartGesture, onSwipe, ...props }) => {
  const config = {
    velocityThreshold: 0.2,
    directionalOffsetThreshold: 80,
  };

  return (
    <GestureRecognizer
      onResponderGrant={() => {
        onStartGesture();
      }}
      onSwipe={(direction) => {
        onSwipe(direction);
      }}
      config={config}
      onTap={() => {
        onSwipe(swipeDirections.SWIPE_UP);
      }}
      style={{ flex: 1 }}
      {...props}
    />
  );
};

const FootprintCanvas = ({ engine }: { engine: Engine }) => {
  const ref = React.useRef<any>(null);

  React.useEffect(() => {
    let rafId: number;
    const draw = () => {
      const canvas = ref.current;
      if (canvas) {
        const ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, 240, 480);
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, 240, 480);
        const angle = 14.5 * Math.PI / 180;
        const cosA = Math.cos(angle), sinA = Math.sin(angle);
        ctx.strokeStyle = "#00ff00";
        ctx.lineWidth = 1;
        for (const { x1, x2, y } of engine.getMovingObjectFootprints()) {
          const mx = (x1 + x2) / 2;
          const hw = (x2 - x1) / 2;
          ctx.beginPath();
          ctx.moveTo(mx - hw * cosA, y - hw * sinA);
          ctx.lineTo(mx + hw * cosA, y + hw * sinA);
          ctx.stroke();
        }
      }
      rafId = requestAnimationFrame(draw);
    };
    rafId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafId);
  }, [engine]);

  return React.createElement("canvas", {
    ref,
    width: 240,
    height: 480,
    style: { width: 240, height: 480, display: "block" },
  });
};

function GameScreen(props) {
  const scheme = useColorScheme();
  const { character, setCharacter } = React.useContext(GameContext);

  return (
    <Game
      {...props}
      character={character}
      setCharacter={setCharacter}
      isDarkMode={scheme === "dark"}
    />
  );
}

export default GameScreen;
