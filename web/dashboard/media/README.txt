Put the annotated video from vision/yolo_demo.py here as yolo_demo.mp4 (H.264):
  ffmpeg -i ../../../vision/out/parking_annotated.mp4 -vcodec libx264 -pix_fmt yuv420p yolo_demo.mp4
